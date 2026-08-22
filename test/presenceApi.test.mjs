// Presence panel integration (PRD-presence.md AC1/AC2): /api/players is the
// authoritative merged view of the cross-room presence registry.
//   - join 'game' (waves) as Alpha AND 'world' as Beta -> count 2, both names
//     with correct modes
//   - one client leaves -> count drops to 1 within the debounce window
// Run: node --test test/presence.test.mjs test/presenceApi.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import WorldRoom from '../src/server/rooms/WorldRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import { _resetForTests, presenceCount } from '../src/server/presence.js';

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
_resetForTests(); // isolate from any other suite sharing this process

const httpServer = http.createServer();
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app)
});
gameServer.define('game', GameRoom);
gameServer.define('world', WorldRoom);
await gameServer.listen(0);
const port = httpServer.address().port;

const fetchPlayers = async () => {
  const res = await fetch(`http://localhost:${port}/api/players`);
  assert.equal(res.status, 200, '/api/players responds 200');
  return await res.json();
};

{
  // Alpha joins a waves room, Beta joins an open-world room.
  const cA = new Client(`ws://localhost:${port}`);
  const rA = await cA.create('game', { name: 'Alpha' }, WorldState);
  const cB = new Client(`ws://localhost:${port}`);
  const rB = await cB.create('world', { name: 'Beta', character: 0 }, WorldState);

  await waitFor(() => presenceCount() >= 2, 5000, 'both joins registered');

  const data = await fetchPlayers();
  assert.equal(data.count, 2, 'count reflects both connected players');
  const byName = Object.fromEntries(data.players.map((p) => [p.name, p.mode]));
  assert.deepEqual(Object.keys(byName).sort(), ['Alpha', 'Beta'], 'exactly the two names');
  assert.equal(byName.Alpha, 'waves', 'GameRoom reports mode waves');
  assert.equal(byName.Beta, 'world', 'WorldRoom reports mode world');
  console.log('ok — presence: waves+world joins listed with modes');

  // AC2: Alpha disconnects -> count drops to 1.
  rA.leave();
  await waitFor(() => presenceCount() === 1, 5000, 'presence drops after leave');
  const after = await fetchPlayers();
  assert.equal(after.count, 1, 'one player remains');
  assert.deepEqual(after.players.map((p) => p.name), ['Beta'], 'Beta is the survivor');
  assert.equal(after.players[0].mode, 'world');
  rB.leave();

  cA.close?.();
  cB.close?.();
}

await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();
_resetForTests(); // teardown hygiene for shared-process suites

console.log('ok — presenceApi.test.mjs: /api/players merges waves+world presence, count drops on leave');
process.exit(0);
