// Waves/daily spectate + spectator counts (PRD-waves-spectate.md):
//   - spectators reach a PLAYING waves or daily room via joinById
//     ({ spectator: true }): they receive the full state snapshot but get NO
//     PlayerState seat and consume no capacity (canJoin semantics unchanged)
//   - presence (/api/players) lists them as '<name> (spec)' with mode
//     'spectating'; /api/rooms annotates every room with a `spectators` count
//   - the daily all-PLAYER-dead finalize ignores spectators entirely: only
//     real players get dailyResult rows + a persisted streak; no crash
//   - spectator leave() drops the /api/rooms `spectators` count back to 0
// Run: node --test test/wavesSpectate.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import { flushAll, _resetForTests, _dirForTests } from '../src/server/persistence.js';
import { utcDateStr } from '../src/shared/sim/dailyRun.js';

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, timeoutMs = 10000, label = 'condition') => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await waitMs(30);
  }
  throw new Error('timeout waiting for ' + label);
};

SERVER.rateLimit.capacity = 10000;
resetRateLimit();

const httpServer = http.createServer();
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app)
});
gameServer.define('game', GameRoom);
gameServer.define('daily', GameRoom);
await gameServer.listen(0);
const port = httpServer.address().port;

const fetchRooms = async () => {
  const res = await fetch(`http://localhost:${port}/api/rooms`);
  assert.equal(res.status, 200, '/api/rooms responds 200');
  return (await res.json()).rooms;
};
const fetchPlayers = async () => {
  const res = await fetch(`http://localhost:${port}/api/players`);
  assert.equal(res.status, 200, '/api/players responds 200');
  return await res.json();
};
const roomOf = (r) => [...GameRoom.instances].find((x) => x.roomId === r.roomId);
const playerFile = (name) => path.join(_dirForTests(), `${name}.json`);
const rmPlayerFile = (name) => { try { fs.rmSync(playerFile(name)); } catch {} };

// Test 1: spectator joins a PLAYING waves room — no seat, presence row,
// spectators count in /api/rooms, canJoin unchanged, leave drops it to 0.
{
  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('game', { name: 'WaveT', character: 0 }, WorldState);
  await waitFor(() => r.state?.matchState === 'playing', 8000, 'waves match playing');
  const sr = roomOf(r);
  assert.ok(sr, 'server-side game room found');
  assert.equal(sr.state.players.size, 1, 'one seated player');

  // canJoin snapshot BEFORE the spectator joins.
  const before = (await fetchRooms()).find((e) => e.roomId === r.roomId);
  assert.ok(before, 'room listed in /api/rooms');

  const cs = new Client(`ws://localhost:${port}`);
  const spec = await cs.joinById(r.roomId, { spectator: true, name: 'WaveSpecT' }, WorldState);
  await waitFor(() => spec.state.matchState === 'playing', 5000, 'spectator received playing state');
  assert.equal(sr.state.players.size, 1, 'spectator got NO seat (players.size unchanged)');
  assert.ok(!sr.state.players.has(spec.sessionId), 'spectator absent from players map');

  // /api/rooms: spectators >= 1 for that roomId, canJoin unchanged.
  await waitFor(async () =>
    ((await fetchRooms()).find((e) => e.roomId === r.roomId)?.spectators ?? 0) >= 1,
    5000, 'spectators count visible in /api/rooms');
  const entry = (await fetchRooms()).find((e) => e.roomId === r.roomId);
  assert.equal(entry.canJoin, before.canJoin, 'canJoin semantics unchanged by spectator');

  // Presence: listed as '<name> (spec)' with mode spectating.
  await waitFor(async () =>
    (await fetchPlayers()).players.some((p) => p.name === 'WaveSpecT (spec)'),
    5000, 'spectator in /api/players');
  const specEntry = (await fetchPlayers()).players.find((p) => p.name === 'WaveSpecT (spec)');
  assert.equal(specEntry.mode, 'spectating', 'presence mode spectating');

  // Spectator leave -> spectators count drops to 0, seats untouched.
  spec.leave();
  await waitFor(async () =>
    ((await fetchRooms()).find((e) => e.roomId === r.roomId)?.spectators ?? 0) === 0,
    5000, 'spectators drops to 0 after leave');
  assert.equal(sr.state.players.size, 1, 'seats untouched after spectator leave');

  r.leave();
  cs.close?.(); c.close?.();
  await waitMs(200);
  console.log('test1 waves spectate + counts ok');
}

// Test 2: daily room finalize with an attached spectator — finalize completes
// for the REAL player only, spectator is not counted as a player, no crash.
{
  rmPlayerFile('DailySpec');
  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('daily', { name: 'DailySpec', character: 0, mode: 'daily' }, WorldState);
  await waitFor(() => r.state?.matchState === 'playing', 8000, 'daily match playing');
  const sr = roomOf(r);

  const cs = new Client(`ws://localhost:${port}`);
  const spec = await cs.joinById(r.roomId, { spectator: true, name: 'DailyWatch' }, WorldState);
  await waitFor(() => spec.state.matchState === 'playing', 5000, 'daily spectator attached');
  assert.equal(sr.state.players.size, 1, 'spectator took no daily seat');

  let resultMsg = null;
  r.onMessage('dailyResult', (msg) => { resultMsg = msg; });

  // Force the wipe: every connected PLAYER dead simultaneously.
  for (const p of sr.state.players.values()) {
    p.x = 0; p.z = 0;
    p.hp = 0;
  }
  await waitFor(() => sr.state.matchState === 'gameover', 3000, 'all-dead ends the daily run');
  await waitFor(() => !!resultMsg, 3000, 'dailyResult broadcast');
  assert.equal(resultMsg.results.length, 1, 'only the real player finalized');
  assert.equal(resultMsg.results[0].name, 'DailySpec', 'result row is the real player');
  assert.ok(spec.state.matchState === 'gameover', 'spectator sees gameover without crash');

  // Persisted record: streak written for the real player only.
  flushAll();
  const rec = JSON.parse(fs.readFileSync(playerFile('DailySpec'), 'utf8'));
  assert.ok(rec.daily.streak >= 1, 'daily.streak written for the real player');
  assert.equal(rec.daily.date, utcDateStr(), 'daily.date is today');

  // Spectator leave -> spectators count drops to 0 (finalize left seats alone).
  spec.leave();
  await waitFor(async () =>
    ((await fetchRooms()).find((e) => e.roomId === r.roomId)?.spectators ?? 0) === 0,
    5000, 'daily spectators drops to 0 after leave');
  assert.equal(sr.state.matchState, 'gameover', 'no crash after spectator leave post-finalize');

  r.leave();
  rmPlayerFile('DailySpec');
  cs.close?.(); c.close?.();
  await waitMs(200);
  console.log('test2 daily finalize ignores spectators ok');
}

rmPlayerFile('WaveT');
_resetForTests();
console.log('ALL WAVES SPECTATE TESTS PASSED');
await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();
process.exit(0);
