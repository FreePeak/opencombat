// Kill streaks integration (PRD-kill-streaks.md, Step B — rooms wiring):
//   - GameRoom credits streaks on every enemy kill (hitEnemy / bash path) and
//     broadcasts EXACTLY ONE 'killStreak' { sid, name, count, label } per
//     MILESTONE count (3 fast kills -> one 'Killing Spree')
//   - kills spaced beyond STREAK_WINDOW_MS never announce (silent restart)
//   - a player death drops their streak (next single kill stays silent)
//   - a match reset drops every streak (resetAll)
//   - LocalRoom emits an identical payload over its message channel (parity)
// Run: node --test test/streaksIntegration.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import { STREAK_WINDOW_MS } from '../src/shared/sim/streaks.js';
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

/** Revive pool slot `i` as a 1-HP sacrificial victim (position irrelevant —
 *  hitEnemy applies its damage directly). */
const sacrifice = (enemies, i) => {
  const e = enemies[i];
  e.hp = 1;
  return e;
};

// ============================================================================
// ONLINE: 3 fast enemy kills -> EXACTLY ONE killStreak broadcast (count 3,
// 'Killing Spree'); the 4th kill inside the window stays silent (next
// milestone is 5).
// ============================================================================
let serverPayload;
{
  const host = await newRoom('Streaker');
  const sr = roomOf(host.r);
  const sid = host.r.sessionId;
  const msgs = [];
  host.r.onMessage('killStreak', (d) => msgs.push(d));

  // Park every live enemy far away so the wave cannot clear mid-test and
  // nobody interferes; we revive dedicated sacrificial slots instead.
  sr.state.enemies.forEach((e) => { if (e.hp > 0) { e.x = 26; e.z = 26; } });

  for (let i = 0; i < 3; i++) {
    const v = sacrifice(sr.state.enemies, i);
    assert.equal(sr.hitEnemy(v, 99, v.x, v.z, sid), true, `kill ${i + 1} lands`);
  }
  // 4th kill INSIDE the window: count 4 — between milestones, silent.
  const fourth = sacrifice(sr.state.enemies, 3);
  assert.equal(sr.hitEnemy(fourth, 99, fourth.x, fourth.z, sid), true);

  await waitFor(() => msgs.length >= 1, 2000, 'killStreak broadcast');
  await waitMs(300); // settle: stragglers would have arrived by now
  assert.equal(msgs.length, 1, 'kills 1..4 announce exactly once');
  serverPayload = msgs[0];
  assert.deepEqual(Object.keys(serverPayload), ['sid', 'name', 'count', 'label']);
  assert.equal(serverPayload.sid, sid);
  assert.equal(serverPayload.name, 'Streaker');
  assert.equal(serverPayload.count, 3);
  assert.equal(serverPayload.label, 'Killing Spree');
  host.r.leave();
}

// ============================================================================
// ONLINE helper-direct, controlled timestamps: kills spaced beyond the window
// NEVER announce — the counter restarts silently at 1.
// ============================================================================
{
  const host = await newRoom('Spaced');
  const sr = roomOf(host.r);
  const sid = host.r.sessionId;
  const msgs = [];
  host.r.onMessage('killStreak', (d) => msgs.push(d));

  const t0 = Date.now();
  sr.creditStreak(sid, t0);                          // count 1
  sr.creditStreak(sid, t0 + STREAK_WINDOW_MS + 100); // window lapsed -> restart
  await waitMs(300);
  assert.equal(msgs.length, 0, 'kills spaced beyond the window never broadcast');
  assert.equal(sr.streaks.get(sid)?.count, 1, 'window lapse silently restarts at 1');
  host.r.leave();
}

// ============================================================================
// ONLINE death reset: 2 kills build toward the milestone, the player dies,
// and the next single kill (which WOULD have been count 3) stays silent.
// ============================================================================
{
  const host = await newRoom('Mortal');
  const sr = roomOf(host.r);
  const sid = host.r.sessionId;
  const msgs = [];
  host.r.onMessage('killStreak', (d) => msgs.push(d));
  const me = sr.state.players.get(sid);

  const t0 = Date.now();
  sr.creditStreak(sid, t0);
  sr.creditStreak(sid, t0 + 50); // count 2 — one short of the milestone
  assert.ok(sr.streaks.has(sid));

  // Real death path: damagePlayer -> strikePlayer lethal -> resetSid hook.
  me.hp = 1;
  assert.equal(sr.damagePlayer(sid, me, 10, me.x + 5, me.z), true, 'lethal hit lands');
  assert.equal(me.hp, 0);
  assert.equal(sr.streaks.has(sid), false, 'death dropped the streak');

  // Next kill restarts at 1 — without the reset it would have been count 3.
  const v = sacrifice(sr.state.enemies, 9);
  assert.equal(sr.hitEnemy(v, 99, v.x, v.z, sid), true);
  await waitMs(300);
  assert.equal(msgs.length, 0, 'no announcement after a death reset');
  host.r.leave();
}

// ============================================================================
// ONLINE match reset: streaks die with the match (resetAll).
// ============================================================================
{
  const host = await newRoom('Resetter');
  const sr = roomOf(host.r);
  const sid = host.r.sessionId;
  const msgs = [];
  host.r.onMessage('killStreak', (d) => msgs.push(d));

  const t0 = Date.now();
  sr.creditStreak(sid, t0);
  sr.creditStreak(sid, t0 + 50);
  sr.resetMatch(); // shared resetMatchState caller side -> resetAll(this.streaks)
  assert.equal(sr.streaks.size, 0, 'match reset cleared every streak');

  sr.creditStreak(sid, Date.now()); // restarts at 1 — silent
  await waitMs(300);
  assert.equal(msgs.length, 0, 'no announcement survives a match reset');
  host.r.leave();
}

await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();

// ============================================================================
// LOCAL PARITY: the offline sim runs the same sequences through its message
// channel and produces byte-equal payloads (identical keys, name/count/label).
// ============================================================================

/** Boot a LocalRoom in 'playing' with the auto-tick loop stopped. */
const localPlaying = async (name) => {
  const room = new LocalRoom();
  await room.join(name, 0);
  room._running = false;
  room._countdownTimer = 0;
  room._step(0.05);
  room.state.orbs.forEach((o) => { o.x = 25; o.z = 25; });
  room.state.powerUps.forEach((p) => { p.active = false; });
  return room;
};

// --- Same 3-kill sequence -> identical payload -------------------------------
{
  const room = await localPlaying('Streaker');
  const msgs = [];
  room.onMessage('killStreak', (d) => msgs.push(d));

  for (let i = 0; i < 3; i++) {
    const v = sacrifice(room.state.enemies, i);
    assert.equal(room._hitEnemy(v, 99, v.x, v.z, room.sessionId), true,
      `LOCAL: kill ${i + 1} lands`);
  }
  assert.equal(msgs.length, 1, 'LOCAL: exactly one killStreak emitted');
  const localMsg = msgs[0];
  assert.deepEqual(Object.keys(localMsg), ['sid', 'name', 'count', 'label'],
    'LOCAL: identical payload shape/key order');
  assert.equal(localMsg.sid, room.sessionId);
  assert.deepEqual(
    { name: localMsg.name, count: localMsg.count, label: localMsg.label },
    { name: serverPayload.name, count: serverPayload.count, label: serverPayload.label },
    'LOCAL: byte-equal killStreak content (same name/count/label)');
  room.leave();
}

// --- Local death reset ---------------------------------------------------------
{
  const room = await localPlaying('Mortal');
  const msgs = [];
  room.onMessage('killStreak', (d) => msgs.push(d));
  const me = room.state.players.get(room.sessionId);

  const t0 = performance.now();
  room._creditStreak(room.sessionId, t0);
  room._creditStreak(room.sessionId, t0 + 50);
  assert.ok(room.streaks.has(room.sessionId));

  me.hp = 1;
  assert.equal(room._damagePlayer(me, 99, null), true, 'LOCAL: lethal hit lands');
  assert.equal(room.streaks.has(room.sessionId), false, 'LOCAL: death dropped the streak');

  const v = sacrifice(room.state.enemies, 9);
  room._hitEnemy(v, 99, v.x, v.z, room.sessionId);
  assert.equal(msgs.length, 0, 'LOCAL: no announcement after a death reset');
  room.leave();
}

// --- Local match reset -----------------------------------------------------------
{
  const room = await localPlaying('Resetter');
  const msgs = [];
  room.onMessage('killStreak', (d) => msgs.push(d));
  const me = room.state.players.get(room.sessionId);

  const t0 = performance.now();
  room._creditStreak(room.sessionId, t0);
  room._creditStreak(room.sessionId, t0 + 50);

  me.score = SERVER.match.targetScore; // force gameover, then playAgain
  room._step(0.05);
  assert.equal(room.state.matchState, 'gameover', 'LOCAL: forced win');
  room.send('playAgain');
  assert.notEqual(room.state.matchState, 'gameover', 'LOCAL: match restarted');
  assert.equal(room.streaks.size, 0, 'LOCAL: match reset cleared every streak');

  room._creditStreak(room.sessionId, performance.now());
  assert.equal(msgs.length, 0, 'LOCAL: no announcement survives a match reset');
  room.leave();
}

console.log('ok — streaksIntegration.test.mjs: 3 fast kills -> exactly ONE killStreak broadcast (count 3, Killing Spree, correct name/sid), 4th in-window kill silent, window-lapsed kills never announce, death reset silences the next kill, match reset clears streaks (server + local), LocalRoom payload parity');
process.exit(0);
