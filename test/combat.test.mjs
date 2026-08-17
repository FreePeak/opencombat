// Combat verification: attacks kill enemies (all classes), attacks work while
// moving, blocking negates frontal hits, and player-vs-player damage works.
// Run: node test/combat.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import { SKILLS } from '../src/shared/skills.js';
import { LocalRoom } from '../src/LocalRoom.js';

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const half = SERVER.world.size / 2;
const face = (px, pz, tx, tz) => Math.atan2(tx - px, tz - pz);

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

// --- ATTACK: every character's J/K makes enemies lose HP until they die ---
{
  const host = await newRoom('Host');
  const sr = roomOf(host.r);
  const me = sr.state.players.get(host.r.sessionId);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
  const enemy = sr.state.enemies[0];
  enemy.x = 2; enemy.z = 0; enemy.hp = SERVER.enemy.hp;

  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitMs(200);
  assert.equal(enemy.hp, SERVER.enemy.hp - SERVER.player.attackDamage, 'J melee costs enemy HP');

  await waitMs(1000);
  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitMs(200);
  assert.equal(enemy.hp, SERVER.enemy.hp, 'second J KILLED the enemy (respawn full)');
  assert.ok(Math.hypot(enemy.x - me.x, enemy.z - me.z) > SERVER.player.attackRange, 'killed enemy respawned away');
  host.r.leave();
}

// --- MOVE GATE: attacks/skills WORK while moving (only L blocks them) ---
{
  const host = await newRoom('Move');
  const sr = roomOf(host.r);
  const me = sr.state.players.get(host.r.sessionId);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
  const enemy = sr.state.enemies[0];
  enemy.x = 2; enemy.z = 0; enemy.hp = SERVER.enemy.hp + SKILLS[0].damage;

  host.r.send('input', { dirX: 1, dirZ: 0, attack: true, anim: 'run' });
  await waitMs(200);
  assert.equal(enemy.hp, SERVER.enemy.hp + SKILLS[0].damage - SERVER.player.attackDamage, 'J hits WHILE MOVING');

  await waitMs(4000);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2; // ensure player is at origin facing +X
  enemy.x = 1; enemy.z = 0; enemy.hp = SERVER.enemy.hp + SKILLS[0].damage;
  const hpBeforeSkill = enemy.hp;
  host.r.send('input', { dirX: 0, dirZ: 1, skill: true, anim: 'run' });
  await waitMs(200);
  assert.ok(enemy.hp < hpBeforeSkill, 'K hits WHILE MOVING (HP decreased)');

  // Guard still blocks
  await waitMs(4000);
  enemy.hp = SERVER.enemy.hp;
  host.r.send('input', { dirX: 0, dirZ: 0, block: true, attack: true, anim: 'idle' });
  await waitMs(200);
  assert.equal(enemy.hp, SERVER.enemy.hp, 'guard REJECTS the swing');
  host.r.leave();
}

// --- BLOCK vs ENEMIES: frontal contact negated; rear lands ---
{
  const host = await newRoom('Block');
  const sr = roomOf(host.r);
  const me = sr.state.players.get(host.r.sessionId);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
  let blockedMsgs = 0;
  host.r.onMessage('blocked', () => { blockedMsgs++; });

  const enemy = sr.state.enemies[0];
  enemy.x = 1; enemy.z = 0;
  host.r.send('input', { dirX: 0, dirZ: 0, block: true, anim: 'idle' });
  await waitMs(1600);
  assert.equal(me.hp, SERVER.player.maxHp, 'frontal contact blocked');
  assert.ok(blockedMsgs > 0, 'BLOCKED message received');

  enemy.x = -1; enemy.z = 0;
  host.r.send('input', { dirX: 0, dirZ: 0, block: true, anim: 'idle' });
  await waitMs(400);
  assert.ok(me.hp < SERVER.player.maxHp, 'rear contact lands through guard');
  host.r.leave();
}

// --- PVP: melee/skills hurt other players; guard negates ---
{
  const host = await newRoom('PvP');
  const sr = roomOf(host.r);
  const A = sr.state.players.get(host.r.sessionId);
  A.x = 0; A.z = 0; A.rotY = Math.PI / 2;

  const c2 = new Client(`ws://localhost:${port}`);
  const r2 = await c2.joinById(host.r.roomId, { name: 'Victim' }, WorldState);
  await waitMs(200);
  const B = sr.state.players.get(r2.sessionId);
  B.x = 1.5; B.z = 0; B.rotY = -Math.PI / 2;

  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitMs(200);
  assert.equal(B.hp, SERVER.player.maxHp - SERVER.player.attackPvpDamage, 'PvP melee connects');

  let bBlocked = 0;
  r2.onMessage('blocked', () => { bBlocked++; });
  B.x = 1.5; B.z = 0;
  await waitMs(1500);
  r2.send('input', { dirX: 0, dirZ: 0, block: true, anim: 'idle' });
  await waitMs(150);
  const hpBefore = B.hp;
  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitMs(300);
  assert.equal(B.hp, hpBefore, 'BLOCK SUCCESS: no HP loss while guarding');
  assert.ok(bBlocked > 0, 'victim saw BLOCKED feedback');

  r2.leave();
  host.r.leave();
}

await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();

// ============================================================================
// Part 2 — LocalRoom (GitHub Pages offline sim): same rules, deterministic
// ============================================================================
{
  const room = new LocalRoom();
  let blockedMsgs = 0;
  room.onMessage('blocked', () => { blockedMsgs++; });
  await room.join('Solo', 0);
  room._countdownTimer = 0;
  room._step(0.05);
  const me = room.state.players.get(room.sessionId);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
  const enemy = room.state.enemies[0];
  enemy.x = 2; enemy.z = 0;

  // Attack while moving connects
  room.send('input', { dirX: 1, dirZ: 0, attack: true, skill: false, anim: 'run', block: false });
  room._step(0.05);
  assert.equal(enemy.hp, SERVER.enemy.hp - SERVER.player.attackDamage, 'LOCAL: J hits while moving');

  // Guard blocks frontal contact
  enemy.x = 1; enemy.z = 0; enemy.hp = SERVER.enemy.hp;
  room.send('input', { dirX: 0, dirZ: 0, block: true, anim: 'idle' });
  for (let i = 0; i < 30; i++) room._step(0.05);
  assert.equal(me.hp, SERVER.player.maxHp, 'LOCAL: frontal contact blocked');
  assert.ok(blockedMsgs > 0, 'LOCAL: BLOCKED feedback emitted');

  enemy.x = -1; enemy.z = 0;
  room._step(0.05); room._step(0.05);
  assert.ok(me.hp < SERVER.player.maxHp, 'LOCAL: rear contact lands');

  room.leave();
}

console.log('ok — combat.test.mjs: kill-until-death, attacks work while moving, block negates frontal hits, PvP damage, local-sim parity');
process.exit(0);
