// Combat verification: attacks kill enemies (all classes), attacks work while
// moving, blocking negates frontal hits, and player-vs-player damage works.
// Updated for the wave/combat rework: melee damage lands at the swing's
// IMPACT frame (attackImpactMs after the press), killed enemies STAY DEAD
// until the next wave, and hits apply HIT-STUN + knockback.
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
import { SKILLS, classStats } from '../src/shared/skills.js';
import { LocalRoom } from '../src/LocalRoom.js';

// Phase 3: all combat tests run as the KNIGHT (default character 0) — its
// per-class stats (150 HP, melee 2 / PvP 15) replaced the old globals.
const KS = classStats(0);

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const half = SERVER.world.size / 2;
// Wait long enough that a scheduled melee impact (attackImpactMs) has been
// processed by the room's 50ms tick — with margin.
const waitImpact = () => waitMs(SERVER.player.attackImpactMs + 250);
const waitFor = async (cond, timeoutMs = 10000, label = 'condition') => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await waitMs(30);
  }
  throw new Error('timeout waiting for ' + label);
};
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
// Park the enemies we are NOT testing far away so they cannot wander into
// the scene and add noise (rear hits on the blocker etc.).
const parkOthers = (sr, keep = 0) => {
  sr.state.enemies.forEach((e, i) => {
    if (i !== keep && e.hp > 0) { e.x = 26; e.z = 26; }
  });
};

// --- ATTACK: J costs enemy HP at the impact frame, kills stay dead --------
{
  const host = await newRoom('Host');
  const sr = roomOf(host.r);
  const me = sr.state.players.get(host.r.sessionId);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
  parkOthers(sr, 0);
  const enemy = sr.state.enemies[0];
  enemy.x = 2; enemy.z = 0;
  // Knight melee (2) one-shots a wave-1 enemy (hp 2) — give it enough HP to
  // SURVIVE the first swing so the hit-stun assertions below have a survivor.
  enemy.hp = SERVER.enemy.hp + KS.meleeDamage;

  // Orbs award score on passive proximity pickup and respawn at a random
  // spot — park them away so the kill-score assertion below measures only
  // the kill's contribution.
  sr.state.orbs.forEach((o) => { o.x = 25; o.z = 25; });
  const scoreBefore = me.score;
  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  // ANIM: the swing anim starts at press time — remote clients must see
  // the attack clip from the start, not only at impact time (180ms later).
  // The send is async; wait one server tick for it to be processed.
  await waitMs(SERVER.tickMs + 50);
  assert.equal(me.anim, 'attack', 'anim is attack after J press (before impact)');
  // Server truth: while the strike is still pending, no damage may have
  // landed. Gate on pendingMelee so a CI stall that already resolved the
  // impact cannot fail this pre-impact check spuriously.
  const impactStillPending = sr.pendingMelee.length > 0;
  if (impactStillPending) {
    assert.equal(enemy.hp, SERVER.enemy.hp + KS.meleeDamage, 'no damage while the strike is still pending');
  }
  const xBeforeImpact = enemy.x; // still approaching the player (x falling)
  // Drive off server truth: wait until the scheduled impact has been
  // processed by the room tick — melee() applies hp/knockback/hit-stun in
  // the same pass that drains pendingMelee.
  await waitFor(() => sr.pendingMelee.length === 0, 2000, 'impact resolved');
  assert.equal(enemy.hp, SERVER.enemy.hp, 'J melee costs enemy HP at impact (knight melee 2)');
  // HIT-STUN: the struck enemy stops acting and shows the hit react.
  assert.equal(enemy.anim, 'hit', 'struck enemy is in hit-stun');
  // Knockback comparison is only meaningful when we truly sampled the
  // pre-impact position (see impactStillPending above).
  if (impactStillPending) {
    assert.ok(enemy.x > xBeforeImpact,
      `struck enemy knocked back (x rose ${xBeforeImpact.toFixed(2)} -> ${enemy.x.toFixed(2)} despite chasing)`);
  }

  await waitMs(SERVER.enemy.hitStunMs + 300); // stun over, cooldown over
  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitImpact();
  assert.equal(enemy.hp, 0, 'second J KILLED the enemy');
  assert.equal(me.score, scoreBefore + SERVER.enemy.killScore, 'kill awarded killScore');
  assert.equal(sr.state.matchState, 'playing', 'wave not cleared: others alive');
  // Corpse is FROZEN (AI skips hp<=0) — no teleport respawn, ever.
  const xDead = enemy.x;
  await waitMs(500);
  assert.equal(enemy.x, xDead, 'killed enemy STAYS PUT (corpse frozen, no respawn)');
  host.r.leave();
}

// --- MOVE GATE: attacks/skills WORK while moving (only L blocks them) ------
{
  const host = await newRoom('Move');
  const sr = roomOf(host.r);
  const me = sr.state.players.get(host.r.sessionId);
  me.x = 0; me.z = 0;
  parkOthers(sr, 0);
  const enemy = sr.state.enemies[0];

  // Moving attack: flee in -X with the enemy behind — it must still be in
  // the frontal arc at the (delayed) impact frame.
  enemy.x = -1.5; enemy.z = 0; enemy.hp = SERVER.enemy.hp;
  me.rotY = -Math.PI / 2; // face -X, straight at it
  host.r.send('input', { dirX: -1, dirZ: 0, attack: true, anim: 'run' });
  await waitImpact();
  assert.equal(enemy.hp, SERVER.enemy.hp - KS.meleeDamage, 'J hits WHILE MOVING (impact-aligned)');

  // Park the movement intent BEFORE arming the skill scenario: stepPlayer
  // snaps rotY to atan2(intent) on EVERY tick while any intent is active,
  // so the stale flee intent would rotate the caster back to -PI/2 within
  // one tick of us writing PI/2 — a laggy cast then dashes backwards.
  // With a zero intent, stepPlayer leaves rotY exactly where we set it.
  host.r.send('input', { dirX: 0, dirZ: 0, attack: false, anim: 'idle' });
  await waitMs(4000);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
  // Phase 3: SKILLS[0] is now 'bash' (4-unit dash + cone at landing).
  // Place the enemy well INSIDE the forward cone but far enough past the
  // landing point that its own chase (toward the player) cannot carry it
  // behind the landing before the cast resolves.
  enemy.x = SKILLS[0].dashDistance + 3; enemy.z = 0;
  enemy.hp = SERVER.enemy.hp + SKILLS[0].damage;
  const hpBeforeSkill = enemy.hp;
  // Cast WHILE MOVING (+X, matching the frozen facing): the cast message
  // itself carries the movement, and until it lands the zeroed intent
  // guarantees rotY is still PI/2 when castSkill samples it.
  host.r.send('input', { dirX: 1, dirZ: 0, skill: true, anim: 'run' });
  // Poll server truth instead of a fixed sleep: the bash cone lands after
  // the dash, and CI scheduling can push that well past 250ms.
  // NOTE: the intent MUST match the facing (+X, toward the enemy) — the
  // bash dash follows the caster's LIVE rotY at cast-processing time, and
  // movePlayers steers rotY toward the active move intent every tick. A
  // perpendicular/stale intent let late-delivered casts rotate the dash
  // off-target (observed once as a cone miss under suite load).
  await waitFor(() => enemy.hp < hpBeforeSkill, 3000, 'K hits WHILE MOVING (skill damage lands)');

  // Guard still blocks
  await waitMs(4000);
  parkOthers(sr, 0);
  enemy.hp = SERVER.enemy.hp;
  host.r.send('input', { dirX: 0, dirZ: 0, block: true, attack: true, anim: 'idle' });
  await waitImpact();
  assert.equal(enemy.hp, SERVER.enemy.hp, 'guard REJECTS the swing');
  host.r.leave();
}

// --- BLOCK vs ENEMIES: frontal contact negated; rear lands ----------------
{
  const host = await newRoom('Block');
  const sr = roomOf(host.r);
  const me = sr.state.players.get(host.r.sessionId);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
  parkOthers(sr, 0);
  let blockedMsgs = 0;
  host.r.onMessage('blocked', () => { blockedMsgs++; });

  const enemy = sr.state.enemies[0];
  enemy.x = 1; enemy.z = 0;
  host.r.send('input', { dirX: 0, dirZ: 0, block: true, anim: 'idle' });
  await waitMs(1600);
  assert.equal(me.hp, KS.hp, 'frontal contact blocked');
  assert.ok(blockedMsgs > 0, 'BLOCKED message received');

  enemy.x = -1; enemy.z = 0;
  host.r.send('input', { dirX: 0, dirZ: 0, block: true, anim: 'idle' });
  // Poll server truth: rear contact lands on an enemy tick after the chase,
  // which can exceed a fixed 400ms sleep under CI load.
  await waitFor(() => me.hp < KS.hp, 3000, 'rear contact lands through guard');
  host.r.leave();
}

// --- PVP: melee/skills hurt other players; guard negates -------------------
{
  const host = await newRoom('PvP');
  const sr = roomOf(host.r);
  const A = sr.state.players.get(host.r.sessionId);
  A.x = 0; A.z = 0; A.rotY = Math.PI / 2;
  parkOthers(sr, -1); // park them ALL: no enemy noise in the PvP section

  const c2 = new Client(`ws://localhost:${port}`);
  const r2 = await c2.joinById(host.r.roomId, { name: 'Victim' }, WorldState);
  await waitMs(200);
  const B = sr.state.players.get(r2.sessionId);
  B.x = 1.5; B.z = 0; B.rotY = -Math.PI / 2;

  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  // Poll server truth: socket delivery + impact scheduling can exceed the
  // fixed 430ms waitImpact budget under concurrent-suite load.
  await waitFor(() => B.hp === KS.hp - KS.meleePvpDamage, 3000, 'PvP melee connects (per-class damage)');

  let bBlocked = 0;
  r2.onMessage('blocked', () => { bBlocked++; });
  B.x = 1.5; B.z = 0;
  await waitMs(1500);
  r2.send('input', { dirX: 0, dirZ: 0, block: true, anim: 'idle' });
  await waitMs(150);
  const hpBefore = B.hp;
  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitImpact();
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
  // Stop the auto-tick loop so the test can drive _step manually without
  // the timer processing pending strikes before the manual step does.
  room._running = false;
  room._countdownTimer = 0;
  room._step(0.05);
  const me = room.state.players.get(room.sessionId);
  me.x = 0; me.z = 0; me.rotY = -Math.PI / 2;
  room.state.enemies.forEach((e, i) => {
    if (i > 0) { e.x = 25; e.z = 25; } // park the others
  });
  const enemy = room.state.enemies[0];
  enemy.x = -1.5; enemy.z = 0;
  enemy.hp = SERVER.enemy.hp + KS.meleeDamage; // survive the knight's 2-damage swing

  // Attack while moving connects — at the delayed impact frame.
  room.send('input', { dirX: -1, dirZ: 0, attack: true, skill: false, anim: 'run', block: false });
  room._step(0.05);
  assert.equal(enemy.hp, SERVER.enemy.hp + KS.meleeDamage, 'LOCAL: no damage before the impact frame');
  await waitMs(SERVER.player.attackImpactMs + 200);
  room._step(0.05);
  assert.equal(enemy.hp, SERVER.enemy.hp, 'LOCAL: J hits while moving (impact-aligned)');
  assert.equal(enemy.anim, 'hit', 'LOCAL: struck enemy is in hit-stun');

  // Guard blocks frontal contact (stop, reset the encounter, wait out the
  // stun, then re-engage frontally).
  room.send('input', { dirX: 0, dirZ: 0, attack: false, skill: false, anim: 'idle', block: false });
  await waitMs(SERVER.enemy.hitStunMs + 250);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
  me.hp = KS.hp; // undo any contact damage from the chase
  me._lastHit = 0;
  enemy.x = 1; enemy.z = 0; enemy.hp = SERVER.enemy.hp;
  room.send('input', { dirX: 0, dirZ: 0, block: true, anim: 'idle' });
  for (let i = 0; i < 30; i++) room._step(0.05);
  assert.equal(me.hp, KS.hp, 'LOCAL: frontal contact blocked');
  assert.ok(blockedMsgs > 0, 'LOCAL: BLOCKED feedback emitted');

  enemy.x = -1; enemy.z = 0;
  room._step(0.05); room._step(0.05);
  assert.ok(me.hp < KS.hp, 'LOCAL: rear contact lands');

  room.leave();
}

console.log('ok — combat.test.mjs: impact-aligned kills that stay dead, hit-stun, attacks while moving, block negates frontal hits, PvP damage, local-sim parity');
process.exit(0);
