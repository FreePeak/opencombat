// Admin API + GDPR rights + audit log (PRD-admin-api.md):
//   - ADMIN_TOKEN unset -> every /api/admin/* answers 404 (feature off,
//     zero surface; env flipped within one run — the guard reads lazily)
//   - wrong/missing bearer token -> 401 on all four routes
//   - GET /api/admin/players lists persisted players (tolerates malformed)
//   - GET /api/admin/players/:name exports the byte-complete record
//     (deep-equals the stored JSON file)
//   - DELETE /api/admin/players/:name removes the file durably — a queued
//     debounced save cannot resurrect it — 404 unknown
//   - every export/delete (+ delete failure) lands an audit line
//     {ts, actor:'admin', action, target, outcome} in data/audit.jsonl;
//     plain listing writes none
//   - token compare unit: constant-time helper on sha256 digests
// Run: node --test test/adminApi.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Server, WebSocketTransport } from 'colyseus';
import GameRoom from '../src/server/rooms/GameRoom.js';
import ArenaRoom from '../src/server/rooms/ArenaRoom.js';
import WorldRoom from '../src/server/rooms/WorldRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp, adminTokenMatches } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import {
  flushAll, _resetForTests, _dirForTests,
  loadPlayer, savePlayerDebounced
} from '../src/server/persistence.js';
import { appendAudit, readTail, _auditFileForTests } from '../src/server/auditLog.js';

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Token starts UNSET so scenario A can prove the feature-off surface before
// any request carries a credential; the guard reads the env per-request.
delete process.env.ADMIN_TOKEN;

SERVER.rateLimit.capacity = 10000;
resetRateLimit();

// OUR files only — foreign player records in the shared data dir untouched.
const playersDir = _dirForTests();
const auditFile = _auditFileForTests();
const ours = ['AdminTL', 'AdminTX', 'AdminTE', 'AdminTD'];
const fileOf = (name) => path.join(playersDir, `${name}.json`);
for (const f of [...ours.map(fileOf), path.join(playersDir, 'AdminBad.json'), auditFile]) {
  fs.rmSync(f, { force: true });
}

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

const TOKEN = 'admin-test-token-9f2c';
const authed = { authorization: `Bearer ${TOKEN}` };

const call = async (method, urlPath, headers = {}) => {
  const res = await fetch(`${base}${urlPath}`, { method, headers });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
};

const adminRoutes = [
  ['GET', '/api/admin/players'],
  ['GET', '/api/admin/players/AdminTE'],
  ['DELETE', '/api/admin/players/AdminTE'],
  ['GET', '/api/admin/audit'],
];

// ---------------------------------------------------------------------------
// Scenario A — feature off (AC1): no ADMIN_TOKEN configured -> every admin
// route answers 404 exactly like any unknown path (zero surface).
for (const [method, url] of adminRoutes) {
  const r = await call(method, url);
  assert.equal(r.status, 404, `${method} ${url} -> 404 while feature off`);
}
console.log('ok — ADMIN_TOKEN unset: all /api/admin/* routes 404 (feature off)');
process.env.ADMIN_TOKEN = TOKEN;

// ---------------------------------------------------------------------------
// Scenario B — digest-compare helper unit contract: equal tokens match,
// anything else does not, mismatched lengths never throw.
assert.equal(adminTokenMatches(TOKEN, TOKEN), true, 'identical tokens match');
assert.equal(adminTokenMatches('wrong', TOKEN), false, 'wrong token rejected');
assert.equal(adminTokenMatches(undefined, TOKEN), false, 'missing provided rejected');
assert.equal(adminTokenMatches('', ''), true, 'empty-vs-empty digests equal');
assert.equal(adminTokenMatches('a', 'a-longer-token'), false, 'length mismatch rejected, no throw');
assert.equal(adminTokenMatches(`${TOKEN}x`, TOKEN), false, 'suffix extension rejected');
console.log('ok — adminTokenMatches: sha256 digest compare, wrong/missing/extended all fail');

// ---------------------------------------------------------------------------
// Scenario C — wrong or missing token (AC2): 401 for all operations once the
// feature is configured.
for (const [method, url] of adminRoutes) {
  const wrong = await call(method, url, { authorization: 'Bearer not-the-token' });
  assert.equal(wrong.status, 401, `${method} ${url}: wrong token -> 401`);
  const missing = await call(method, url);
  assert.equal(missing.status, 401, `${method} ${url}: missing token -> 401`);
}
console.log('ok — wrong/missing bearer token: 401 on list/export/delete/audit');

// ---------------------------------------------------------------------------
// Scenario D — listing shape: seeded records appear with level + career
// bests; malformed sibling files are tolerated (skipped), foreign records
// in the shared dir are listed best-effort without breaking the response.
fs.writeFileSync(fileOf('AdminTL'), JSON.stringify({
  name: 'AdminTL', level: 4, xp: 120,
  career: { runs: 7, victories: 1, bestWave: 9, bestScore: 812 }
}, null, 2));
savePlayerDebounced('AdminTX', { name: 'AdminTX', level: 2, career: { bestWave: 3, bestScore: 140 } });
flushAll(); // flush the queued save to disk like a settled debounce tick

{
  const r = await call('GET', '/api/admin/players', authed);
  assert.equal(r.status, 200, 'list responds 200');
  const byName = Object.fromEntries(r.body.players.map((p) => [p.name, p]));
  const tl = byName.AdminTL;
  assert.ok(tl, 'seeded player present in listing');
  assert.deepEqual(tl.career, { bestWave: 9, bestScore: 812 }, 'career bests carried through');
  assert.equal(tl.level, 4, 'level carried through');
  const tx = byName.AdminTX;
  assert.ok(tx && tx.level === 2 && tx.career.bestScore === 140,
    'savePlayerDebounced-seeded record listed too');

  // Malformed file must never fail the listing.
  fs.writeFileSync(path.join(playersDir, 'AdminBad.json'), '{not json');
  const after = await call('GET', '/api/admin/players', authed);
  assert.equal(after.status, 200, 'malformed sibling tolerated');
  assert.ok(!after.body.players.some((p) => p.name === 'AdminBad'),
    'malformed file skipped from listing');

  // Listing is a read of the roster, not of another user's data: NO audit line.
  assert.ok(!readTail(100).some((e) => e.action === 'list'),
    'plain listing writes no audit entry');
}
console.log('ok — GET /api/admin/players: shape {name,level,career:{bestWave,bestScore}}, malformed skipped, unaudited');

// ---------------------------------------------------------------------------
// Scenario E — byte-complete export (AC3): the exported record deep-equals
// the stored JSON file content, exotic keys included (GDPR portability).
{
  const record = {
    name: 'AdminTE',
    level: 6,
    xp: 333,
    character: 2,
    upgrades: { damage: 3 },
    pendingChoices: [],
    score: 4242,
    oidcSub: null,
    daily: { date: '2026-08-22', bestScore: 90, streak: 2, lastPlayed: '2026-08-22' },
    career: { runs: 11, victories: 2, bestWave: 14, bestScore: 4242 },
    nested: { deeply: { array: [1, 'two', { three: 3 }] } }
  };
  fs.writeFileSync(fileOf('AdminTE'), JSON.stringify(record, null, 2));
  const r = await call('GET', '/api/admin/players/AdminTE', authed);
  assert.equal(r.status, 200, 'export responds 200');
  assert.deepEqual(r.body, JSON.parse(fs.readFileSync(fileOf('AdminTE'), 'utf8')),
    'export deep-equals the stored record byte-for-byte (parsed)');

  // Unknown name -> 404.
  const miss = await call('GET', '/api/admin/players/NobodyHere', authed);
  assert.equal(miss.status, 404, 'unknown export target -> 404');

  const expOk = readTail(50).filter((e) => e.action === 'export' && e.target === 'AdminTE').pop();
  assert.ok(expOk, 'export audited');
  assert.equal(expOk.outcome, 'ok', 'successful export outcome ok');
  assert.equal(expOk.actor, 'admin', 'actor recorded');
  assert.ok(typeof expOk.ts === 'string' && !Number.isNaN(Date.parse(expOk.ts)),
    'audit ts is an ISO timestamp');
}
console.log('ok — GET /api/admin/players/:name: byte-complete export, 404 unknown, audited');

// ---------------------------------------------------------------------------
// Scenario F — durable delete (AC4): file gone AND the queued debounced save
// canceled, so loadPlayer stays null even after the debounce window elapses
// (the writer cannot resurrect the deleted record).
{
  fs.writeFileSync(fileOf('AdminTD'), JSON.stringify(
    { name: 'AdminTD', level: 1, career: { bestWave: 1, bestScore: 10 } }, null, 2));
  // Queue an in-flight debounced save that would normally rewrite the file
  // ~2s later — the delete hook must cancel it BEFORE unlinking.
  savePlayerDebounced('AdminTD', { name: 'AdminTD', level: 99, resurrect: true });

  const r = await call('DELETE', '/api/admin/players/AdminTD', authed);
  assert.equal(r.status, 200, 'delete responds 200');
  assert.deepEqual(r.body, { deleted: 'AdminTD' }, '{deleted:name} shape');
  assert.equal(fs.existsSync(fileOf('AdminTD')), false, 'player file removed from disk');
  assert.equal(loadPlayer('AdminTD'), null, 'loadPlayer null right after delete');

  // Past the original debounce deadline: still gone (no resurrection).
  await waitMs((SERVER.persistence?.debounceMs ?? 2000) + 400);
  assert.equal(fs.existsSync(fileOf('AdminTD')), false, 'file still gone after debounce window');
  assert.equal(loadPlayer('AdminTD'), null, 'loadPlayer still null after debounce window');

  // Deleting an unknown name -> 404, and the failure IS audited (AC5).
  const again = await call('DELETE', '/api/admin/players/AdminTD', authed);
  assert.equal(again.status, 404, 'second delete of same name -> 404');

  const delOk = readTail(50).filter((e) => e.action === 'delete' && e.target === 'AdminTD'
    && e.outcome === 'ok').pop();
  assert.ok(delOk, 'successful delete audited');
  assert.equal(delOk.actor, 'admin', 'delete audit actor');
  assert.ok(delOk.ts, 'delete audit timestamp');
  const delFail = readTail(50).filter((e) => e.action === 'delete' && e.target === 'AdminTD'
    && e.outcome === 'fail').pop();
  assert.ok(delFail, 'failed (404) delete audited too');
}
console.log('ok — DELETE /api/admin/players/:name: durable (no resurrection), 404 repeat, ok+fail audited');

// ---------------------------------------------------------------------------
// Scenario G — GET /api/admin/audit returns the tail (last 100 parsed lines).
{
  appendAudit({ action: 'probe', target: 'AdminTailProbe', outcome: 'ok' });
  const r = await call('GET', '/api/admin/audit', authed);
  assert.equal(r.status, 200, 'audit endpoint 200');
  assert.ok(Array.isArray(r.body.entries), '{entries:[...]} shape');
  assert.ok(r.body.entries.length <= 100, 'tail bounded at 100 lines');
  assert.ok(r.body.entries.some((e) => e.action === 'export' && e.target === 'AdminTE'),
    'tail includes earlier export entry');
  assert.ok(r.body.entries.some((e) => e.action === 'probe' && e.target === 'AdminTailProbe'),
    'tail includes freshly appended entry');
}
console.log('ok — GET /api/admin/audit: last-N parsed lines incl. fresh appends');

// --- teardown ------------------------------------------------------------------
flushAll();
_resetForTests();
for (const f of [...ours.map(fileOf), path.join(playersDir, 'AdminBad.json'), auditFile]) {
  fs.rmSync(f, { force: true });
}
delete process.env.ADMIN_TOKEN;
httpServer.closeAllConnections?.();
await new Promise((r) => httpServer.close(r));
await gameServer.gracefullyShutdown(false);

console.log('ok — adminApi.test.mjs: feature-off 404s, 401s, list shape, byte-complete export, durable delete, audit trail green');
process.exit(0);
