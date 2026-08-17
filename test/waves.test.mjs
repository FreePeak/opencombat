// Wave system verification (server room + LocalRoom parity):
//   - wave 1 spawns waveEnemyCount(1) enemies out of the pool; extra slots dead
//   - clearing every enemy -> matchState 'intermission' (popup-gated)
//   - during intermission players are INVULNERABLE (no PvP/enemy damage)
//   - intermission never auto-advances; 'nextWave' click -> countdown -> next
//     wave with more, tankier enemies
//   - hit-stun freezes enemy AI (no chase, no contact damage)
//   - play-again resets to wave 1
// Run: node test/waves.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import { waveEnemyCount, waveEnemyHp } from '../src/shared/waves.js';
import { LocalRoom } from '../src/LocalRoom.js';

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, timeoutMs = 10000, label = 'condition') => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await waitMs(30);
  }
  throw new Error('timeout waiting for ' + label);
};

SERVER.rateLimit.capacity = 10000;
const httpServer = http.createServer();
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app)
});
gameServer.define('game', GameRoom);
await gameServer.listen(0);
const port = httpServer.address().port;

const newRoom = async (name) => {
  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('game', { name }, WorldState);
  while (r.state?.matchState !== 'playing') await waitMs(30);
  return { c, r };
};
const roomOf = (r) => [...GameRoom.instances].find((x) => x.roomId === r.roomId);
const aliveCount = (state) => state.enemies.filter((e) => e.hp > 0).length;

// --- Wave 1 shape ------------------------------------------------------------
{
  const host = await newRoom('Waves');
  const sr = roomOf(host.r);
  assert.equal(sr.state.wave, 1, 'match starts at wave 1');
  assert.equal(aliveCount(sr.state), waveEnemyCount(1), 'wave 1 activates its count');
  assert.equal(sr.state.enemies.length, SERVER.enemy.pool, 'pool holds every slot');
  assert.ok(sr.state.enemies.slice(waveEnemyCount(1)).every((e) => e.hp === 0),
    'unused pool slots are dead');
  host.r.leave();
}

// --- Clearing the wave -> intermission (gated on click) ----------------------
{
  const host = await newRoom('Clearer');
  const sr = roomOf(host.r);
  const me = sr.state.players.get(host.r.sessionId);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;

  // Cluster every wave-1 enemy in the frontal arc at 1 HP: one swing kills all.
  const alive = sr.state.enemies.filter((e) => e.hp > 0);
  alive.forEach((e, i) => {
    e.hp = 1;
    const ang = (i - (alive.length - 1) / 2) * 0.3; // small fan ahead (+X)
    e.x = 1.8 * Math.cos(ang);
    e.z = 1.8 * Math.sin(ang);
  });
  const scoreBefore = me.score;
  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitFor(() => sr.state.matchState === 'intermission', 2000, 'intermission after full clear');
  assert.ok(sr.state.enemies.every((e) => e.hp <= 0), 'every enemy dead');
  assert.equal(sr.state.wave, 1, 'wave number unchanged during intermission');
  assert.equal(me.score - scoreBefore, alive.length * SERVER.enemy.killScore,
    'each kill awarded killScore');

  // INVULNERABLE during intermission: a PvP swing cannot even start (input
  // gate), so the victim's HP cannot move.
  const c2 = new Client(`ws://localhost:${port}`);
  const r2 = await c2.joinById(host.r.roomId, { name: 'Rival' }, WorldState);
  await waitMs(200);
  const B = sr.state.players.get(r2.sessionId);
  B.x = 1.5; B.z = 0;
  const hpBefore = B.hp;
  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitMs(600);
  assert.equal(B.hp, hpBefore, 'intermission: players are invulnerable');
  assert.notEqual(sr.state.matchState, 'playing', 'intermission does not auto-advance');

  // nextWave click -> countdown -> playing with a bigger wave.
  host.r.send('nextWave');
  await waitFor(() => sr.state.matchState === 'countdown', 1000, 'countdown after nextWave');
  await waitFor(() => sr.state.matchState === 'playing', 5000, 'playing after wave countdown');
  assert.equal(sr.state.wave, 2, 'wave counter advanced');
  assert.equal(aliveCount(sr.state), waveEnemyCount(2), 'wave 2 activates more slots');
  assert.ok(sr.state.enemies.slice(0, waveEnemyCount(2)).every((e) => e.hp === waveEnemyHp(2)),
    'wave-2 enemies spawn at wave-2 HP');

  r2.leave();
  host.r.leave();
}

// --- HIT-STUN: a struck enemy stops acting ------------------------------------
{
  const host = await newRoom('Stun');
  const sr = roomOf(host.r);
  const me = sr.state.players.get(host.r.sessionId);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
  sr.state.enemies.forEach((e, i) => { if (i > 0) { e.x = 26; e.z = 26; } });
  const enemy = sr.state.enemies[0];
  enemy.x = 2.2; enemy.z = 0; enemy.hp = waveEnemyHp(99); // tanky: survives the hit
  const hpBefore = enemy.hp;

  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitFor(() => enemy.hp < hpBefore, 1500, 'strike landed');
  const xAtHit = enemy.x;
  const hpAtHit = me.hp;
  // The player runs far away — a STUNNED enemy must not chase (and cannot
  // reach contact) until the stun expires.
  me.x = -20; me.z = -20;
  await waitMs(300);
  assert.ok(Math.abs(enemy.x - xAtHit) < 0.05, 'stunned enemy does not chase');
  assert.equal(me.hp, hpAtHit, 'stunned enemy deals no contact damage');
  assert.equal(enemy.anim, 'hit', 'stunned enemy plays the hit react');
  // After the stun it resumes the chase (converging on the new position).
  await waitFor(() => Math.hypot(enemy.x - me.x, enemy.z - me.z) < 10, 5000, 'chase resumed after stun');
  host.r.leave();
}

// --- Play again resets to wave 1 ----------------------------------------------
{
  const host = await newRoom('Again');
  const sr = roomOf(host.r);
  host.r.send('nextWave'); // rejected: not intermission
  assert.equal(sr.state.wave, 1, 'nextWave rejected outside intermission');
  const me = sr.state.players.get(host.r.sessionId);
  me.score = SERVER.match.targetScore; // force the win
  await waitFor(() => sr.state.matchState === 'gameover', 3000, 'gameover after target score');
  host.r.send('playAgain');
  await waitFor(() => sr.state.matchState === 'playing', 6000, 'playing after play again');
  assert.equal(sr.state.wave, 1, 'play again resets to wave 1');
  assert.equal(aliveCount(sr.state), waveEnemyCount(1), 'wave 1 reactivated');
  host.r.leave();
}

await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();

// ============================================================================
// LocalRoom parity: the offline solo sim runs the same wave flow
// ============================================================================
{
  const room = new LocalRoom();
  await room.join('Solo', 0);
  room._running = false;
  room._countdownTimer = 0;
  room._step(0.05);
  assert.equal(room.state.matchState, 'playing', 'LOCAL: playing after countdown');
  assert.equal(room.state.wave, 1, 'LOCAL: starts at wave 1');
  assert.equal(room.state.enemies.filter((e) => e.hp > 0).length, waveEnemyCount(1),
    'LOCAL: wave 1 count');

  // Kill the whole wave with one impact-aligned swing (1 HP fan ahead).
  const me = room.state.players.get(room.sessionId);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
  const alive = room.state.enemies.filter((e) => e.hp > 0);
  alive.forEach((e, i) => {
    e.hp = 1;
    const ang = (i - (alive.length - 1) / 2) * 0.3;
    e.x = 1.8 * Math.cos(ang);
    e.z = 1.8 * Math.sin(ang);
  });
  room.send('input', { dirX: 0, dirZ: 0, attack: true, skill: false, anim: 'attack', block: false });
  room._step(0.05); // process the attack input → schedule the pending melee strike
  await waitMs(SERVER.player.attackImpactMs + 250);
  room._step(0.05); // resolve the strike → kills all enemies → wave clear
  assert.equal(room.state.matchState, 'intermission', 'LOCAL: intermission after full clear');
  assert.ok(room.state.enemies.every((e) => e.hp <= 0), 'LOCAL: all dead');

  // Intermission invulnerability is enforced in the local sim too.
  me.hp = 50;
  assert.equal(room._damagePlayer(me, 10, null), false, 'LOCAL: damage rejected during intermission');
  assert.equal(me.hp, 50, 'LOCAL: hp untouched during intermission');

  // The popup gates the next wave; wave 2 is bigger.
  room.send('nextWave');
  assert.equal(room.state.matchState, 'countdown', 'LOCAL: nextWave starts countdown');
  room._countdownTimer = 0;
  room._step(0.05);
  assert.equal(room.state.matchState, 'playing', 'LOCAL: playing after wave countdown');
  assert.equal(room.state.wave, 2, 'LOCAL: wave 2');
  const alive2 = room.state.enemies.filter((e) => e.hp > 0);
  assert.equal(alive2.length, waveEnemyCount(2), 'LOCAL: wave 2 count');
  assert.ok(alive2.every((e) => e.hp === waveEnemyHp(2)), 'LOCAL: wave-2 HP');

  room.leave();
}

console.log('ok — waves.test.mjs: wave spawning/scaling, intermission gate + invulnerability, nextWave click flow, hit-stun freeze, play-again reset, local-sim parity');
process.exit(0);
