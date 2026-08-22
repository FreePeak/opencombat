// Verified-name join guard (PRD-name-guard.md):
//   - all three room types (game/arena/world) REJECT a fresh join whose name
//     maps to a player file carrying oidcSub unless the join options carry a
//     valid single-use join ticket (code 4103 'name locked by verified account')
//   - a minted ticket lets exactly ONE join through; reuse is rejected
//   - unbound names are untouched (guest isolation)
//   - the guard is SKIPPED entirely when the OIDC feature flag is off
//   - GET /auth/join-token mints for a live session cookie, 401 otherwise
// Enforcement is driven by the tests-only _setOidcEnabledForTests hook (no
// stub IdP needed); tickets are minted via the internal mintTicketForSession.
// Run: node --test test/nameGuard.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import ArenaRoom from '../src/server/rooms/ArenaRoom.js';
import WorldRoom from '../src/server/rooms/WorldRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import {
  assertNameJoinable,
  mintTicketForSession,
  _setOidcEnabledForTests,
  _testSeedSession
} from '../src/server/auth/oidc.js';
import { flushAll, _resetForTests, _dirForTests } from '../src/server/persistence.js';

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, timeoutMs = 5000, label = 'condition') => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await waitMs(30);
  }
  throw new Error('timeout waiting for ' + label);
};

// Feature off by default in this process; the hook drives enforcement below.
delete process.env.OIDC_ISSUER;
delete process.env.OIDC_CLIENT_ID;
delete process.env.OIDC_CLIENT_SECRET;
_setOidcEnabledForTests(true); // BEFORE buildHttpApp so /auth/* routes mount

SERVER.rateLimit.capacity = 10000;
resetRateLimit();

// Player-file hygiene: OUR names only; foreign files untouched.
const playersDir = _dirForTests();
const lockedFile = path.join(playersDir, 'LockedT.json');
const guestFile = path.join(playersDir, 'GuestNG.json');
for (const f of [lockedFile, guestFile]) fs.rmSync(f, { force: true });
// Minimal verified-bound record (WorldRoom load path reads level/xp/etc).
fs.writeFileSync(lockedFile, JSON.stringify({
  name: 'LockedT', oidcSub: 'sub-A', character: 0, level: 3, xp: 40,
  score: 100, upgrades: {}, pendingChoices: []
}, null, 2));

const httpServer = http.createServer();
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app)
});
gameServer.define('game', GameRoom);
gameServer.define('arena', ArenaRoom);
gameServer.define('world', WorldRoom);
await gameServer.listen(0);
const port = httpServer.address().port;
const base = `http://127.0.0.1:${port}`;

const instancesOf = (kind) =>
  ({ game: GameRoom.instances, arena: ArenaRoom.instances, world: WorldRoom.instances })[kind].size;

/** True when any live room of `kind` holds a seat named `name` (failed-create
 *  rooms linger until the empty-room TTL, so leak checks look at seats). */
const hasSeat = (kind, name) =>
  [...{ game: GameRoom.instances, arena: ArenaRoom.instances, world: WorldRoom.instances }[kind]]
    .some((room) => {
      try { return [...room.state.players.values()].some((p) => p.name === name); }
      catch { return false; }
    });

/** Attempt a fresh create; resolves on rejection with the error. */
async function joinFailure(kind, options) {
  const c = new Client(`ws://localhost:${port}`);
  let err = null;
  try {
    await c.create(kind, options, WorldState);
  } catch (e) {
    err = e;
  }
  c.connection?.close(); // failed joins leave a dead socket behind
  if (!err) throw new Error(`expected ${kind} join to be rejected (${JSON.stringify(options)})`);
  return err;
}

// ---------------------------------------------------------------------------
// Scenario A — oidc-disabled flag skips the guard entirely (guest-only
// deployments keep byte-identical behavior even on a bound name).
{
  _setOidcEnabledForTests(false);
  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('game', { name: 'LockedT' }, WorldState);
  await waitFor(() => r.state.players.get(r.sessionId), 5000, 'player seat sync');
  assert.equal(r.state.players.get(r.sessionId)?.name, 'LockedT',
    'guard skipped: bound-name guest join succeeds while feature is off');
  await r.leave();
  _setOidcEnabledForTests(true);
  console.log('ok — oidc disabled: guard skipped, guest joins bound name');
}

// ---------------------------------------------------------------------------
// Scenario B — every room type rejects a no-ticket fresh join on the bound
// name (AC1), before any seat is created.
for (const kind of ['game', 'arena', 'world']) {
  const err = await joinFailure(kind, kind === 'arena'
    ? { name: 'LockedT', mode: 'ffa' }
    : { name: 'LockedT' });
  assert.match(err.message, /name locked by verified account/,
    `${kind}: typed rejection message`);
  assert.equal(err.code, 4103, `${kind}: typed rejection code`);
  assert.equal(hasSeat(kind, 'LockedT'), false,
    `${kind}: rejected join created no seat`);

  // Garbage tickets are just as rejected.
  const err2 = await joinFailure(kind, kind === 'arena'
    ? { name: 'LockedT', mode: 'ffa', joinTicket: 'forged' }
    : { name: 'LockedT', joinTicket: 'forged' });
  assert.match(err2.message, /name locked by verified account/,
    `${kind}: forged ticket rejected too`);
}
console.log('ok — game/arena/world all reject bound-name joins without a valid ticket');

// ---------------------------------------------------------------------------
// Scenario C — GET /auth/join-token: 401 anonymous, {ticket} for a live
// session cookie.
const sessionId = _testSeedSession('LockedT');
{
  const anon = await fetch(`${base}/auth/join-token`);
  assert.equal(anon.status, 401, 'no session cookie -> 401');

  const authed = await fetch(`${base}/auth/join-token`, {
    headers: { Cookie: `sid=${sessionId}` }
  });
  assert.equal(authed.status, 200, 'live session cookie -> 200');
  const body = await authed.json();
  assert.ok(typeof body.ticket === 'string' && body.ticket.length > 20,
    'response shape {ticket}');
}
console.log('ok — /auth/join-token: 401 anonymous, ticket minted for live session');

// ---------------------------------------------------------------------------
// Scenario D — a minted ticket admits exactly ONE join (AC2), reuse rejected.
{
  const ticket = mintTicketForSession(sessionId);
  assert.ok(ticket, 'internal mint returns a ticket');

  const c1 = new Client(`ws://localhost:${port}`);
  const r1 = await c1.create('game',
    { name: 'LockedT', joinTicket: ticket }, WorldState);
  await waitFor(() => r1.state.players.get(r1.sessionId), 5000, 'verified seat sync');
  const me = r1.state.players.get(r1.sessionId);
  assert.equal(me?.name, 'LockedT', 'verified holder joins with valid ticket');
  await r1.leave();
  await waitMs(50);

  // Single-use: the SAME ticket cannot admit a second join anywhere.
  const err = await joinFailure('game', { name: 'LockedT', joinTicket: ticket });
  assert.match(err.message, /name locked by verified account/, 'second use rejected');
  console.log('ok — valid ticket allows one join; second use rejected');
}

// ---------------------------------------------------------------------------
// Scenario E — unbound names are never locked (AC3 guest isolation).
{
  fs.rmSync(guestFile, { force: true }); // ensure NO player file exists
  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('game', { name: 'GuestNG' }, WorldState);
  await waitFor(() => r.state.players.get(r.sessionId), 5000, 'guest seat sync');
  assert.equal(r.state.players.get(r.sessionId)?.name, 'GuestNG',
    'unbound guest name joins with no ticket while enabled');
  await r.leave();
  console.log('ok — unbound names unaffected by the guard');
}

// ---------------------------------------------------------------------------
// Scenario F — unit-level contract: typed error code 4103 straight from the
// helper, plus the guest fast-path.
{
  assert.throws(() => assertNameJoinable('LockedT', {}),
    (e) => e.code === 4103 && /name locked by verified account/.test(e.message),
    'bound name + no ticket throws code 4103');
  assert.doesNotThrow(() => assertNameJoinable('NobodyHere', {}),
    'unbound name passes without a ticket');
  console.log('ok — assertNameJoinable unit contract (code 4103)');
}

// --- teardown ----------------------------------------------------------------
flushAll();
_resetForTests();
for (const f of [lockedFile, guestFile]) fs.rmSync(f, { force: true });
_setOidcEnabledForTests(null);
httpServer.closeAllConnections?.();
await new Promise((r) => httpServer.close(r));
await gameServer.gracefullyShutdown(false);

console.log('ok — nameGuard.test.mjs: three-room enforcement, single-use ticket, guest isolation, disabled-skip green');
process.exit(0);
