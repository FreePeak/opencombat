// Arena spectate (PRD-arena-spectate.md): server-side spectator joins.
//   - spectators reach a playing FFA arena via joinById({ spectator: true }):
//     they receive the full state snapshot but get NO PlayerState seat, NO
//     capacity rejection, NO input scratch state, NO team rebalance
//   - presence (/api/players) lists them as '<name> (spec)' with mode
//     'spectating' and drops the entry again on leave
//   - joining as spectator during the LOBBY phase must not trigger countdown /
//     auto-start: matchState stays 'lobby', players.size unchanged
//   - spectator leave() only removes presence — seats stay untouched
// Run: node --test test/spectate.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import ArenaRoom from '../src/server/rooms/ArenaRoom.js';
import LobbyRoom from '../src/server/rooms/LobbyRoom.js';
import { WorldState, LobbyState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';

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

const httpServer = http.createServer();
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app)
});
gameServer.define('arena', ArenaRoom);
gameServer.define('lobby', LobbyRoom);
await gameServer.listen(0);
const port = httpServer.address().port;

const fetchPlayers = async () => {
  const res = await fetch(`http://localhost:${port}/api/players`);
  assert.equal(res.status, 200, '/api/players responds 200');
  return await res.json();
};
const roomOfArena = (r) => [...ArenaRoom.instances].find((x) => x.roomId === r.roomId);

// Test 1: spectator joins a PLAYING arena — sees state, takes no seat,
// appears in presence, disappears from it on leave.
{
  // Two players queue an FFA duel via lobby -> redirect (FFA leaves
  // maxClients headroom for the spectator join).
  const c1 = new Client(`ws://localhost:${port}`);
  const c2 = new Client(`ws://localhost:${port}`);
  const lobby1 = await c1.joinOrCreate('lobby', { name: 'LobbyA', character: 0 }, LobbyState);
  const lobby2 = await c2.joinOrCreate('lobby', { name: 'LobbyB', character: 1 }, LobbyState);
  const p1Redirect = new Promise((res) => lobby1.onMessage('redirect', res));
  const p2Redirect = new Promise((res) => lobby2.onMessage('redirect', res));
  lobby1.send('queue', { mode: 'ffa', pve: false, roundsToWin: 2 });
  lobby2.send('queue', { mode: 'ffa', pve: false, roundsToWin: 2 });
  const [res1, res2] = await Promise.all([p1Redirect, p2Redirect]);
  assert.equal(res1.roomId, res2.roomId, 'both players redirected to same arena');
  const arena1 = await c1.consumeSeatReservation(res1);
  const arena2 = await c2.consumeSeatReservation(res2);
  await waitFor(() => arena1.state.matchState === 'playing', 15000, 'arena playing');
  assert.equal(arena1.state.players.size, 2, 'two seated players');

  // Third client spectates: full state snapshot, zero seat side effects.
  const cs = new Client(`ws://localhost:${port}`);
  const spec = await cs.joinById(res1.roomId, { spectator: true, name: 'SpecT' }, WorldState);
  await waitFor(() => spec.state.matchState === 'playing', 5000, 'spectator received playing state');
  const sr = roomOfArena(arena1);
  assert.ok(sr, 'server-side arena room found');
  assert.equal(sr.state.players.size, 2, 'spectator got NO seat (players.size unchanged)');
  assert.ok(!sr.state.players.has(spec.sessionId), 'spectator absent from players map');
  assert.ok(!sr.inputs.has(spec.sessionId), 'no input scratch state for spectator');
  assert.ok(!sr._teamAssignment.has(spec.sessionId), 'no team assigned to spectator');
  assert.equal(spec.state.matchState, 'playing', 'matchState readable from spectator');

  // Presence: listed as '<name> (spec)' with mode spectating.
  await waitFor(async () =>
    (await fetchPlayers()).players.some((p) => p.name === 'SpecT (spec)'), 5000, 'spectator in /api/players');
  const data = await fetchPlayers();
  const specEntry = data.players.find((p) => p.name === 'SpecT (spec)');
  assert.equal(specEntry.mode, 'spectating', 'presence mode spectating');

  // Spectator leave -> presence gone, player seats untouched.
  spec.leave();
  await waitFor(async () =>
    !(await fetchPlayers()).players.some((p) => p.name === 'SpecT (spec)'), 5000, 'spectator presence dropped');
  assert.equal(sr.state.players.size, 2, 'seats untouched after spectator leave');

  arena1.leave(); arena2.leave();
  lobby1.leave(); lobby2.leave();
  cs.close?.(); c1.close?.(); c2.close?.();
  await waitMs(200);
  console.log('test1 spectate playing ok');
}

// Test 2: spectator joins a LOBBY-phase arena — no countdown / auto-start
// side effects, roster unchanged.
{
  // Fresh arena straight from the gameServer: single creator in team mode
  // (minPlayers 4) guarantees the room sits in 'lobby'.
  const c1 = new Client(`ws://localhost:${port}`);
  const r1 = await c1.create('arena', { mode: 'team', pve: false }, WorldState);
  await waitMs(150); // let the creator's join settle
  const sr = roomOfArena(r1);
  assert.ok(sr, 'fresh arena room found');
  assert.equal(sr.state.matchState, 'lobby', 'fresh team arena starts in lobby');
  const sizeBefore = sr.state.players.size;

  const cs = new Client(`ws://localhost:${port}`);
  const spec = await cs.joinById(r1.roomId, { spectator: true, name: 'Lurker' }, WorldState);
  await waitFor(() =>
    spec.state.players.size === sizeBefore && spec.state.matchState === 'lobby',
    5000, 'spectator sees lobby-phase state');
  await waitMs(600); // a countdown WOULD have flipped matchState by now
  assert.equal(sr.state.matchState, 'lobby', 'no countdown started by spectator join');
  assert.equal(sr.state.countdown, 0, 'countdown value untouched');
  assert.equal(sr.state.players.size, sizeBefore, 'players.size unchanged');

  const data = await fetchPlayers();
  const lurk = data.players.find((p) => p.name === 'Lurker (spec)');
  assert.ok(lurk, 'presence lists Lurker (spec)');
  assert.equal(lurk.mode, 'spectating', 'lobby-phase spectator mode spectating');

  spec.leave(); r1.leave();
  cs.close?.(); c1.close?.();
  await waitMs(200);
  console.log('test2 spectate lobby ok');
}

console.log('ALL SPECTATE TESTS PASSED');
await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();
process.exit(0);
