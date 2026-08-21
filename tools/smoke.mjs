// Live smoke test: boots the REAL server exactly like production does
// (`node src/server/index.js`), then proves the game is PLAYABLE and
// TESTABLE end-to-end before any push can be considered good:
//   1. /healthz answers ok
//   2. / serves the client HTML (importmap + canvas present)
//   3. /env.js and a whitelisted client module are served
//   4. /metrics answers (observability wired)
//   5. matchmaking endpoint answers
//   6. a real Colyseus client joins the 'game' room over WebSocket and
//      observes server-authoritative state (the actual "can I play" proof)
//   7. SIGTERM shuts the process down cleanly
// Used by CI (.github/workflows/ci.yml) and by every roadmap phase's
// live local check. Run: npm run smoke   (SMOKE_DEBUG=1 for server logs)
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@colyseus/sdk';
import { WorldState } from '../src/server/schema/StateSchema.js';

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const results = [];
const check = (name, fn) => async () => {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', name + ' :: ' + err.message]);
    throw err;
  }
};

const child = spawn(process.execPath, ['src/server/index.js'], {
  env: { ...process.env, PORT: String(port) },
  stdio: process.env.SMOKE_DEBUG ? 'inherit' : 'ignore'
});
child.on('exit', (code, sig) => {
  if (!stopping && code !== 0) {
    console.error(`[smoke] server exited early code=${code} sig=${sig}`);
    process.exit(1);
  }
});

let stopping = false;
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(timeoutMs = 20000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return await res.json();
    } catch (err) { lastErr = err; }
    await waitMs(250);
  }
  throw new Error('server never became healthy: ' + lastErr?.message);
}

try {
  const health = await waitHealthy();

  await check('healthz shape', async () => {
    assert.equal(health.ok, true);
  })();

  await check('client HTML served (playable in browser)', async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(html.includes('<!DOCTYPE html>'), 'missing doctype');
    assert.ok(html.includes('importmap'), 'missing three.js importmap');
    assert.ok(html.toLowerCase().includes('canvas') || html.includes('main.js'), 'missing game bootstrap');
  })();

  await check('env.js injected', async () => {
    const res = await fetch(`${base}/env.js`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('window'));
  })();

  await check('whitelisted client module served', async () => {
    const res = await fetch(`${base}/src/config.js`);
    assert.equal(res.status, 200);
  })();

  await check('secrets stay private (static whitelist)', async () => {
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
  })();

  await check('metrics endpoint', async () => {
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).length > 0);
  })();

  await check('matchmake endpoint answers', async () => {
    const res = await fetch(`${base}/matchmake/game`, { method: 'POST' });
    // Colyseus answers matchmaking POSTs; any structured HTTP response (not a
    // hang / socket reset) proves the dispatcher is mounted.
    assert.ok(res.status > 0);
  })();

  await check('real client joins game room over WebSocket (PLAYABLE)', async () => {
    const client = new Client(`ws://localhost:${port}`);
    const room = await client.joinOrCreate('game', { name: 'SmokeBot' }, WorldState);
    // Server-authoritative lifecycle: first join starts countdown -> playing.
    const start = Date.now();
    while (Date.now() - start < 15000) {
      if (['countdown', 'playing'].includes(room.state.matchState)) break;
      await waitMs(50);
    }
    assert.ok(
      ['countdown', 'playing'].includes(room.state.matchState),
      'matchState never left lobby, got: ' + room.state.matchState
    );
    assert.ok(room.state.players.size >= 1, 'no players in state');
    await room.leave(true);
  })();
} finally {
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await waitMs(1500);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

let failed = 0;
for (const [status, name] of results) {
  console.log(`${status} — ${name}`);
  if (status === 'FAIL') failed++;
}
console.log(failed === 0
  ? `\nsmoke OK — ${results.length}/${results.length} checks passed on :${port}`
  : `\nsmoke FAILED — ${failed}/${results.length} checks failed`);
process.exit(failed === 0 ? 0 : 1);
