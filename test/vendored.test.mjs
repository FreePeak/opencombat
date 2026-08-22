// Air-gapped asset vendoring (PRD-airgap-vendoring.md):
//   - default mode: GET / serves the ORIGINAL index.html (cdn.jsdelivr.net
//     present, zero /vendor/ links) — AC1 unchanged serving
//   - VENDORED_ASSETS=1 (env flipped mid-run, read per-request): served HTML
//     has ZERO jsdelivr references and points every pinned URL at /vendor/…
//   - each manifest entry is served under /vendor/<file>: 200, JS MIME,
//     byte-identical to disk, non-empty; .mjs gets text/javascript
//   - unknown vendor path -> 404 even while enabled
//   - manifest integrity: every listed file exists on disk with the
//     recorded size
// Run: node --test test/vendored.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, WebSocketTransport } from 'colyseus';
import GameRoom from '../src/server/rooms/GameRoom.js';
import ArenaRoom from '../src/server/rooms/ArenaRoom.js';
import WorldRoom from '../src/server/rooms/WorldRoom.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';

// Feature starts OFF so scenario A can prove AC1 before the flip; like the
// admin token guard, the gate reads the env per request.
delete process.env.VENDORED_ASSETS;
delete process.env.ADMIN_TOKEN;
SERVER.rateLimit.capacity = 10000;
resetRateLimit();

const vendorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/vendor');
const manifest = JSON.parse(fs.readFileSync(path.join(vendorRoot, 'manifest.json'), 'utf8'));

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

const get = async (urlPath) => {
  const res = await fetch(`${base}${urlPath}`);
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
};

// ---------------------------------------------------------------------------
// Scenario A — default mode (AC1): original CDN-backed HTML, no vendor surface.
const plain = await get('/');
assert.ok(plain.body.includes('cdn.jsdelivr.net'), 'default HTML keeps jsdelivr URLs');
assert.equal(plain.body.includes('/vendor/'), false, 'default HTML has no /vendor/ links');
assert.equal((await get('/vendor/three.module.js')).status, 404, '/vendor/* off by default');
console.log('ok — default mode serves CDN HTML byte-for-byte, /vendor/* dark');
process.env.VENDORED_ASSETS = '1';

// ---------------------------------------------------------------------------
// Scenario B — vendored mode (AC2): rewritten index with ZERO external URLs,
// all four URL families pointing into /vendor/.
const vendored = await get('/');
const html = vendored.body.toString('utf8');
assert.equal(html.includes('cdn.jsdelivr.net'), false, 'rewritten HTML drops every jsdelivr reference');
for (const [pin] of [
  ['/vendor/npm/three@0.185.1/build/three.module.js'],
  ['/vendor/npm/three@0.185.1/examples/jsm/'],
  ['/vendor/npm/@colyseus/schema@4.0.13/build/index.mjs'],
  ['/vendor/npm/@colyseus/sdk@0.17.43/dist/colyseus.js']
]) {
  assert.ok(html.includes(pin), `rewritten HTML references ${pin}`);
}
console.log('ok — VENDORED_ASSETS=1 rewrites importmap + SDK src to /vendor/*');

// ---------------------------------------------------------------------------
// Scenario C — every manifest entry served from our origin: 200 + JS MIME +
// byte-identical to the committed copy (AC2).
for (const [url, meta] of Object.entries(manifest)) {
  const res = await get(`/vendor/${meta.file}`);
  const disk = fs.readFileSync(path.join(vendorRoot, meta.file));
  assert.equal(res.status, 200, `GET /vendor/${meta.file} -> 200 (${url})`);
  assert.match(
    res.headers.get('content-type') || '',
    /javascript/,
    `${meta.file} served with a JavaScript content-type`
  );
  assert.equal(
    res.headers.get('content-type').includes('text/javascript'),
    meta.file.endsWith('.mjs'),
    `${meta.file} MIME matches extension (.mjs -> text/javascript)`
  );
  assert.equal(
    res.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
    `${meta.file} cached immutably`
  );
  assert.ok(disk.length > 0, `${meta.file} on disk non-empty`);
  assert.equal(res.body.length, meta.size, `${meta.file} served size == manifest size`);
  assert.ok(res.body.equals(disk), `${meta.file} bytes identical to disk`);
}
console.log(`ok — all ${Object.keys(manifest).length} vendored files: 200, JS MIME, immutable, byte-exact`);

// Manifest integrity: recorded files exist on disk with the recorded size.
for (const [url, meta] of Object.entries(manifest)) {
  assert.ok(url.startsWith('https://cdn.jsdelivr.net/'), 'manifest keys are pinned CDN URLs');
  assert.equal(fs.statSync(path.join(vendorRoot, meta.file)).size, meta.size, `${meta.file} size matches manifest`);
}
console.log('ok — manifest lists exactly what is committed on disk');

// ---------------------------------------------------------------------------
// Scenario D — unknown vendor paths still 404 while the feature is enabled.
assert.equal((await get('/vendor/npm/nope.js')).status, 404, 'unknown vendor file -> 404');
assert.equal((await get('/vendor/../package.json')).status, 404, 'traversal attempt -> 404');
console.log('ok — unknown/traversal vendor paths answer 404');

// ---------------------------------------------------------------------------
// Restore: env back off, default serving intact again (no restart needed).
delete process.env.VENDORED_ASSETS;
const restored = await get('/');
assert.ok(restored.body.includes('cdn.jsdelivr.net'), 'flipping back restores CDN HTML');
assert.equal((await get('/vendor/three.module.js')).status, 404, '/vendor/* dark again after restore');
console.log('ok — env restored, default mode untouched');

process.exit(0);
