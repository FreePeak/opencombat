// Elite affixes integration (PRD-elite-affixes.md, Step B — server + local
// sim wiring): every ELITE_EVERY_N_WAVES-th wave spawns slot 0 as an ELITE
// with a wave-deterministic affix, announced to clients; affix behavior is
// wired into both rooms' shared sim (chase speed, vampiric siphon, Volatile
// death fuse with delayed AoE, Bulwark knockback immunity) and elite kills
// pay double score/XP.
// Run: node --test test/elitesIntegration.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import { waveEnemyHp } from '../src/shared/waves.js';
import {
  affixForWave, affixByName,
} from '../src/shared/sim/elites.js';
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

// ============================================================================
// ONLINE: wave 5 marks slot 0 as the Swift elite at scaled HP and announces
// it; non-elite waves spawn zero elites.
// ============================================================================
let serverEliteName;
let serverEliteHp;
{
  const host = await newRoom('Elites');
  const sr = roomOf(host.r);
  let banner = null;
  host.r.onMessage('eliteSpawn', (data) => { banner = data; });

  sr.spawnWave(5); // drive internals directly like the other room tests do
  serverEliteName = affixForWave(5);
  assert.equal(serverEliteName, 'Swift', 'wave 5 carries the first affix');
  serverEliteHp = Math.ceil(waveEnemyHp(5) * affixByName(serverEliteName).hpMul);

  const elites = sr.state.enemies.filter((e) => e.elite !== '');
  assert.equal(elites.length, 1, 'exactly one elite on an elite wave');
  assert.equal(sr.state.enemies[0], elites[0], 'the elite is slot 0');
  assert.equal(elites[0].elite, serverEliteName);
  assert.equal(elites[0].hp, serverEliteHp,
    `elite hp === ceil(base ${waveEnemyHp(5)} * hpMul ${affixByName(serverEliteName).hpMul})`);
  // Everyone else spawned with no affix; hp is the plain wave-5 base OR
  // composed with its archetype multiplier (PRD-enemy-archetypes.md: elite
  // slot stays archetype-free, non-elite slots compose ceil(base * hpMul)).
  const baseHp5 = waveEnemyHp(5);
  assert.ok(sr.state.enemies.slice(1, Math.min(7, sr.state.enemies.length))
    .every((e) => {
      if (e.archetype === 'Rusher') return e.hp === Math.ceil(baseHp5 * 0.75);
      if (e.archetype === 'Tank') return e.hp === Math.ceil(baseHp5 * 2);
      if (e.archetype === 'Shooter') return e.hp === baseHp5;
      return e.archetype === '' && e.hp === baseHp5;
    }), 'non-elite slots keep archetype-composed wave HP');

  await waitFor(() => banner, 2000, 'eliteSpawn broadcast');
  assert.deepEqual(banner, { name: serverEliteName });

  sr.spawnWave(6); // not an elite wave
  assert.ok(sr.state.enemies.every((e) => e.elite === ''),
    'wave 6 enemies carry no affix');
  host.r.leave();
}

await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();

// ============================================================================
// LOCAL PARITY: the offline sim produces byte-equal elite stats for wave 5.
// ============================================================================

/** Boot a LocalRoom in 'playing' with the auto-tick loop stopped. */
const localPlaying = async () => {
  const room = new LocalRoom();
  await room.join('Solo', 0);
  room._running = false;
  room._countdownTimer = 0;
  room._step(0.05);
  return room;
};

/** Park orbs/power-ups far away so pickups cannot pollute score/hp asserts. */
const parkPickups = (room) => {
  room.state.orbs.forEach((o) => { o.x = 25; o.z = 25; });
  room.state.powerUps.forEach((p) => { p.active = false; });
};

{
  const room = await localPlaying();
  let banner = null;
  room.onMessage('eliteSpawn', (d) => { banner = d; });
  room._spawnWave(5);
  assert.equal(room.state.enemies[0].elite, serverEliteName, 'LOCAL: same affix as the server room');
  assert.equal(room.state.enemies[0].hp, serverEliteHp, 'LOCAL: byte-equal elite hp');
  assert.ok(room.state.enemies.slice(1).every((e) => e.elite === ''),
    'LOCAL: exactly one elite per elite wave');
  assert.deepEqual(banner, { name: serverEliteName }, 'LOCAL: eliteSpawn surfaces via the message channel');
  room.leave();
}

// --- Swift moves measurably faster than a normal enemy -----------------------
{
  const room = await localPlaying();
  parkPickups(room);
  const me = room.state.players.get(room.sessionId);
  me.x = 0; me.z = 0; // fixed target both chasers converge on
  const norm = room.state.enemies[0];
  const swift = room.state.enemies[1];
  swift.elite = 'Swift'; // scenario marker: same start point, only speed differs
  norm.x = -16; norm.z = 0;
  swift.x = -16; swift.z = 0;
  room.state.enemies.forEach((e, i) => { if (i >= 2) e.hp = 0; }); // dead slots skip AI

  for (let i = 0; i < 24; i++) room._step(0.05); // N ticks toward the player

  const closedNorm = 16 - Math.hypot(norm.x, norm.z);
  const closedSwift = 16 - Math.hypot(swift.x, swift.z);
  const ratio = closedSwift / closedNorm;
  assert.ok(closedSwift > closedNorm, 'Swift closes more distance than normal');
  assert.ok(ratio > 1.5 && ratio < 1.7,
    `distance-closed ratio ~speedMul 1.6 (got ${ratio.toFixed(3)})`);
  room.leave();
}

// --- Vampiric siphons HP back after damaging the player ----------------------
{
  const room = await localPlaying();
  parkPickups(room);
  const me = room.state.players.get(room.sessionId);
  me.x = 0; me.z = 0;
  const vamp = room.state.enemies[0];
  vamp.elite = 'Vampiric';
  room.state.wave = 11; // deep enough that maxHp cap > current hp: ceil(5*1.25)=7
  vamp.hp = 2;          // hurt elite: the heal must be visible AND capped
  vamp.x = -3; vamp.z = 0; // outside contactRange — it must close in and swing
  room.state.enemies.forEach((e, i) => { if (i >= 1) e.hp = 0; });
  const myHpBefore = me.hp;

  for (let i = 0; i < 60 && vamp.hp <= 2; i++) room._step(0.05); // small dt steps

  assert.equal(me.hp, myHpBefore - SERVER.enemy.contactDamage, 'contact hit landed once');
  const cap = Math.ceil(waveEnemyHp(room.state.wave) * affixByName('Vampiric').hpMul);
  assert.equal(cap, 7);
  assert.equal(vamp.hp, Math.min(cap, 2 + affixByName('Vampiric').vampiricPct * SERVER.enemy.contactDamage),
    'vampiric healed by pct*damage, clamped to its maxHp');
  room.leave();
}

// --- Volatile death arms a fuse: delayed AoE, then corpse release -------------
{
  const room = await localPlaying();
  parkPickups(room);
  const me = room.state.players.get(room.sessionId);
  me.x = 0; me.z = 0; // inside the blast radius (dist 2 < r=3)
  const boom = room.state.enemies[0];
  boom.elite = 'Volatile';
  boom.hp = 2;
  boom.x = -2; boom.z = 0;
  room.state.enemies.forEach((e, i) => { if (i >= 2) e.hp = 0; }); // [1] stays alive:
  // ...keeps matchState 'playing' so the explosion is not swallowed by the
  // intermission invulnerability gate.

  const myHpBefore = me.hp;
  const scoreBefore = me.score;
  assert.equal(room._hitEnemy(boom, 99, -6, 0, room.sessionId), true, 'killing blow lands');
  assert.equal(boom.hp, 0);
  assert.equal(me.score - scoreBefore, 2 * SERVER.enemy.killScore,
    'elite kill pays DOUBLE killScore');
  assert.ok(room._volatilePending.has(boom), 'fuse armed on death');

  room._step(0.05); // well before fuseMs: nothing may explode yet
  assert.equal(me.hp, myHpBefore, 'no damage while the fuse burns');
  assert.ok(room._volatilePending.has(boom), 'corpse held until fuse expiry');

  await waitMs(affixByName('Volatile').volatile.fuseMs + 300);
  room._step(0.05); // small dt step past the fuse -> single explosion
  assert.equal(room._volatilePending.has(boom), false, 'corpse released after the blast');
  assert.equal(me.hp, myHpBefore - affixByName('Volatile').volatile.damage,
    'AoE dealt exactly the volatile damage within radius');
  room.leave();
}

// --- Bulwark ignores knockback ------------------------------------------------
{
  const room = await localPlaying();
  const bul = room.state.enemies[0];
  bul.elite = 'Bulwark';
  bul.hp = 100;
  bul.x = 5; bul.z = 5;
  const norm = room.state.enemies[1];
  norm.hp = 100;
  norm.x = 5; norm.z = 5;
  room.state.enemies.forEach((e, i) => { if (i >= 2) e.hp = 0; });

  room._hitEnemy(bul, 10, 3, 3, room.sessionId); // resolveEnemyHit survive path
  assert.equal(bul.hp, 90, 'damage still applies through immunity');
  assert.equal(bul.x, 5, 'knockback skipped on X');
  assert.equal(bul.z, 5, 'knockback skipped on Z');

  room._hitEnemy(norm, 10, 3, 3, room.sessionId);
  assert.equal(norm.hp, 90, 'sanity: normal enemy took the same damage');
  assert.notEqual(norm.x, 5, 'sanity: a normal enemy IS shoved away');
  room.leave();
}

console.log('ok — elitesIntegration.test.mjs: online wave-5 elite + broadcast + clean wave 6, local parity (name+hp), Swift chase ratio ~1.6x, vampiric heal clamped to maxHp, volatile delayed AoE after fuse, bulwark knockback immunity, double killScore burst');
process.exit(0);
