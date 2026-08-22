// Live Match Browser (PRD-live-matches.md) server slice B integration:
//   - GET /api/rooms lists both game rooms with correct mode/phase/players,
//     sorted busiest-first; the PLAYING waves room is joinable, the
//     COUNTDOWN one is not
//   - AC2 late-join fairness: joining a match already 'playing' grants
//     >=2.5s invulnerability (3s grace); joining during countdown keeps the
//     legacy short grace (<=1.5s)
// Run: node --test test/roomsApi.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';

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

const roomOf = (r) => [...GameRoom.instances].find((x) => x.roomId === r.roomId);
const fetchRooms = async () => {
  const res = await fetch(`http://localhost:${port}/api/rooms`);
  assert.equal(res.status, 200, '/api/rooms responds 200');
  return (await res.json()).rooms;
};

let cA; let cB; let cLate; let cEarly;
try {
  // Room B first: it runs its full natural countdown into PLAYING while we
  // still control when room A exists.
  cB = new Client(`ws://localhost:${port}`);
  const rB = await cB.create('game', { name: 'Host' }, WorldState);
  const srB = roomOf(rB);
  assert.ok(srB, 'playing room reachable via GameRoom.instances');
  await waitFor(() => srB.state.matchState === 'playing', 8000, 'room B playing');

  // Room A: created afterwards and PINNED in countdown by refilling the
  // display counter, so the <=1.5s legacy-grace assertion cannot race the
  // 3-2-1-GO transition.
  cA = new Client(`ws://localhost:${port}`);
  const rA = await cA.create('game', { name: 'Countdowner' }, WorldState);
  const srA = roomOf(rA);
  await waitFor(() => srA.state.matchState === 'countdown', 5000, 'room A countdown');
  srA.state.countdown = 999;

  // AC2a: late join into the PLAYING room -> >=2.5s spawn protection.
  cLate = new Client(`ws://localhost:${port}`);
  const rLate = await cLate.joinById(srB.roomId, { name: 'Latecomer' }, WorldState);
  await waitFor(() => srB.state.players.has(rLate.sessionId), 5000, 'late joiner seated');
  assert.ok(srB.invulnUntil.get(rLate.sessionId) >= Date.now() + 2500,
    'mid-match join grants >=2.5s invulnerability');

  // Listing: both rooms present, correct shapes, busiest-first sort.
  let rooms = await fetchRooms();
  const byId = Object.fromEntries(rooms.map((r) => [r.roomId, r]));
  assert.ok(byId[srA.roomId] && byId[srB.roomId], 'both game rooms listed');
  assert.equal(byId[srB.roomId].mode, 'waves', 'game room reports waves mode');
  assert.equal(byId[srB.roomId].players, 2, 'playing room player count');
  assert.equal(byId[srB.roomId].phase, 'playing');
  assert.equal(byId[srB.roomId].canJoin, true, 'playing waves room is joinable');
  assert.equal(byId[srA.roomId].players, 1, 'countdown room player count');
  assert.equal(byId[srA.roomId].phase, 'countdown');
  assert.equal(byId[srA.roomId].canJoin, false, 'countdown room not joinable');
  assert.deepEqual(rooms.map((r) => r.players),
    [...rooms.map((r) => r.players)].sort((a, b) => b - a),
    'rooms sorted by players desc');

  // AC2b: countdown-phase join keeps the legacy grace (<=1.5s).
  cEarly = new Client(`ws://localhost:${port}`);
  const rEarly = await cEarly.joinById(srA.roomId, { name: 'Earlybird' }, WorldState);
  await waitFor(() => srA.state.players.has(rEarly.sessionId), 5000, 'early joiner seated');
  assert.ok(srA.invulnUntil.get(rEarly.sessionId) <= Date.now() + 1500,
    'countdown-phase join keeps legacy short grace');

  // Final listing reflects the second join too.
  rooms = await fetchRooms();
  assert.equal(rooms.find((r) => r.roomId === srA.roomId).players, 2);

  console.log('ok — /api/rooms shapes + phases + canJoin, desc sort, late-join >=2.5s vs legacy grace');
} finally {
  cA?.close?.(); cB?.close?.(); cLate?.close?.(); cEarly?.close?.();
}

await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();

console.log('ok — roomsApi.test.mjs: /api/rooms lists live matches with phases/canJoin, late-join fairness enforced');
process.exit(0);
