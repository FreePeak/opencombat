// OIDC login option (PRD-oidc-login.md) — server slice B integration.
// Drives the FULL browser-less flow against an in-process STUB IdP:
//   - RSA keypair -> SPKI JWK served at /.well-known/jwks.json (fixed kid)
//   - /.well-known/openid-configuration discovery document
//   - /authorize: validates client_id/redirect_uri/state/nonce/PKCE(S256)
//     challenge, issues a single-use code, 302s back with code+state
//   - /token: validates client_secret + PKCE verifier (S256), mints an
//     RS256 ID token (compact JWS via node:crypto createSign 'RSA-SHA256')
// Scenarios: disabled-by-default inertness (AC1), happy path start ->
// callback -> /api/me verified + persisted oidcSub (AC2), both collision
// directions 409 (AC3), logout clearing, stash single-use/expiry, and no
// provider token ever appearing in a client-visible response body (AC4).
// Run: node --test test/oidc.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { calculatePKCECodeChallenge } from 'openid-client';
import { buildHttpApp } from '../src/server/http.js';
import { buildAuthRoutes, _testExpireStashes } from '../src/server/auth/oidc.js';
import { loadPlayer, savePlayerDebounced, flushAll, _resetForTests, _dirForTests } from '../src/server/persistence.js';

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// --- STUB IdP ---------------------------------------------------------------
const KID = 'oidc-test-kid';
const CLIENT_ID = 'test-client';
const CLIENT_SECRET = 'test-secret';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

function signIdToken(claims) {
  const header = b64u(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const payload = b64u(JSON.stringify(claims));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64u(signer.sign(privateKey))}`;
}

let currentSub = 'sub-default'; // test scenarios point this before each flow
const codes = new Map(); // code -> { challenge, nonce }
const issuedIdTokens = []; // for AC4 leak assertions

const idp = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://stub');
  if (u.pathname === '/.well-known/openid-configuration') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks.json`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256']
    }));
    return;
  }
  if (u.pathname === '/jwks.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
    return;
  }
  if (u.pathname === '/authorize') {
    const codeChallenge = u.searchParams.get('code_challenge');
    if (u.searchParams.get('client_id') !== CLIENT_ID ||
        !u.searchParams.get('redirect_uri') ||
        !u.searchParams.get('state') ||
        !u.searchParams.get('nonce') ||
        u.searchParams.get('code_challenge_method') !== 'S256' ||
        !codeChallenge) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request' }));
      return;
    }
    const code = crypto.randomBytes(16).toString('base64url');
    codes.set(code, { challenge: codeChallenge, nonce: u.searchParams.get('nonce') });
    const redirect = new URL(u.searchParams.get('redirect_uri'));
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', u.searchParams.get('state'));
    res.writeHead(302, { location: redirect.toString() });
    res.end();
    return;
  }
  if (u.pathname === '/token' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const p = new URLSearchParams(body);
      if (p.get('client_id') !== CLIENT_ID || p.get('client_secret') !== CLIENT_SECRET) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }
      const entry = codes.get(p.get('code'));
      codes.delete(p.get('code')); // single-use regardless of outcome
      if (!entry || (await calculatePKCECodeChallenge(p.get('code_verifier'))) !== entry.challenge) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const idToken = signIdToken({
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: currentSub,
        exp: now + 60,
        iat: now,
        nonce: entry.nonce
      });
      issuedIdTokens.push(idToken);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'STUB_ACCESS_TOKEN',
        token_type: 'Bearer',
        expires_in: 60,
        id_token: idToken
      }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

await new Promise((r) => idp.listen(0, '127.0.0.1', r));
const ISSUER = `http://127.0.0.1:${idp.address().port}`;

// Ensure the disabled scenario really is disabled.
delete process.env.OIDC_ISSUER;
delete process.env.OIDC_CLIENT_ID;
delete process.env.OIDC_CLIENT_SECRET;
delete process.env.OIDC_REDIRECT_URI;
delete process.env.APP_URL;

// Cookie helpers (manual jar semantics): capture Set-Cookie pairs, forward
// them by hand on subsequent requests.
const cookiePair = (res, name) => {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return raw ? raw.slice(name.length + 1).split(';')[0] : null;
};
const setCookieRaw = (res, name) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) || '';

// Every client-visible body across every flow lands here for the AC4 scan.
const chainBodies = [];
const readBody = async (res) => {
  const text = await res.text();
  chainBodies.push(text);
  return text;
};

// Player-file hygiene: these are OUR names only; foreign files untouched.
const playersDir = _dirForTests();
const ourNames = ['OidcT', 'BoundT', 'FreshT', 'ReplayT'];
for (const name of ourNames) fs.rmSync(path.join(playersDir, `${name}.json`), { force: true });

// ---------------------------------------------------------------------------
// Scenario A — disabled by default (AC1): full production stack, env absent.
{
  const app = express();
  buildHttpApp(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const start = await fetch(`${base}/auth/login/start?name=Guest`);
  chainBodies.push(await start.text());
  assert.equal(start.status, 404, 'disabled: /auth/login/start is inert 404');
  assert.equal(start.headers.getSetCookie().length, 0, 'disabled: NO Set-Cookie ever');

  const callback = await fetch(`${base}/auth/callback?code=x&state=y`);
  assert.equal(callback.status, 404, 'disabled: /auth/callback is inert 404');
  const me = await fetch(`${base}/api/me`);
  assert.equal(me.status, 404, 'disabled: /api/me stays unregistered (feature-off signal)');
  const logout = await fetch(`${base}/auth/logout`, { redirect: 'manual' });
  assert.equal(logout.status, 404, 'disabled: /auth/logout is inert 404');
  console.log('ok — oidc disabled-by-default: all auth routes 404, zero cookies set');

  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

// ---------------------------------------------------------------------------
// Enabled stack: bare express + buildAuthRoutes + catch-all (mirrors the
// production mount order inside buildHttpApp).
process.env.OIDC_ISSUER = ISSUER;
process.env.OIDC_CLIENT_ID = CLIENT_ID;
process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;

const app = express();
buildAuthRoutes(app);
app.use((_req, res) => res.status(404).json({ error: 'not found' }));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const appPort = server.address().port;
process.env.OIDC_REDIRECT_URI = `http://127.0.0.1:${appPort}/auth/callback`;
const base = `http://127.0.0.1:${appPort}`;

/** One full login flow: start -> (stub authorize) -> callback. Returns the
 *  pieces scenarios assert on. Callback status is NOT asserted here so
 *  rejection flows can check their own codes. */
async function driveLogin(playerName, subject = 'sub-default') {
  currentSub = subject;
  const startRes = await fetch(
    `${base}/auth/login/start${playerName ? `?name=${encodeURIComponent(playerName)}` : ''}`,
    { redirect: 'manual' }
  );
  await readBody(startRes);
  assert.equal(startRes.status, 302, 'start redirects to the issuer authorize URL');
  const stashCookie = cookiePair(startRes, 'oidc_stash');
  assert.ok(stashCookie, 'start sets the pre-session stash cookie');
  assert.match(setCookieRaw(startRes, 'oidc_stash'), /HttpOnly/, 'stash cookie HttpOnly');
  assert.match(setCookieRaw(startRes, 'oidc_stash'), /SameSite=Lax/, 'stash cookie SameSite=Lax');
  assert.match(setCookieRaw(startRes, 'oidc_stash'), /Path=\//, 'stash cookie Path=/');

  const authorizeRes = await fetch(startRes.headers.get('location'), { redirect: 'manual' });
  await readBody(authorizeRes);
  assert.equal(authorizeRes.status, 302, 'stub IdP authorizes and redirects back');

  const cbUrl = authorizeRes.headers.get('location');
  assert.ok(cbUrl.startsWith(process.env.OIDC_REDIRECT_URI), 'callback hits the configured redirect URI');
  const cbRes = await fetch(cbUrl, {
    redirect: 'manual',
    headers: { Cookie: `oidc_stash=${stashCookie}` }
  });
  await readBody(cbRes);
  return {
    startRes,
    cbRes,
    cbUrl,
    stashCookie,
    sid: cookiePair(cbRes, 'sid'),
    location: cbRes.headers.get('location')
  };
}

const meOf = async (sid) => {
  const res = await fetch(`${base}/api/me`, { headers: sid ? { Cookie: `sid=${sid}` } : {} });
  const json = await res.json();
  chainBodies.push(JSON.stringify(json));
  return { status: res.status, json };
};

// ---------------------------------------------------------------------------
// Scenario B — happy path (AC2/AC4): OidcT signs in, gets a verified session.
{
  const { cbRes, sid, location } = await driveLogin('OidcT', 'sub-happy-123');
  assert.equal(cbRes.status, 302, 'callback succeeds');
  assert.equal(location, '/?login=ok', 'callback redirects to the menu');
  assert.ok(sid, 'callback issues session cookie');
  assert.match(setCookieRaw(cbRes, 'sid'), /HttpOnly/);
  assert.match(setCookieRaw(cbRes, 'sid'), /SameSite=Lax/);
  assert.match(setCookieRaw(cbRes, 'sid'), /Path=\//);

  const me = await meOf(sid);
  assert.deepEqual(me.json, { name: 'OidcT', verified: true }, '/api/me reports verified identity');

  flushAll(); // force the debounced oidcSub write
  const rec = JSON.parse(fs.readFileSync(path.join(playersDir, 'OidcT.json'), 'utf8'));
  assert.equal(rec.oidcSub, 'sub-happy-123', 'player file gains the matching oidcSub');
  assert.equal(loadPlayer('OidcT').oidcSub, 'sub-happy-123', 'loadPlayer sees the binding too');

  // Anonymous /api/me stays guest-shaped.
  const anon = await meOf(null);
  assert.deepEqual(anon.json, { verified: false }, 'no cookie -> verified:false');
  console.log('ok — happy path: start -> callback -> verified me + persisted oidcSub');
}

// ---------------------------------------------------------------------------
// Scenario C — stash hygiene: replay + expiry.
{
  const first = await driveLogin('ReplayT', 'sub-replay');
  assert.equal(first.cbRes.status, 302);
  // Replay: same callback URL + same (now consumed) pre-session cookie.
  const replay = await fetch(first.cbUrl, {
    redirect: 'manual',
    headers: { Cookie: `oidc_stash=${first.stashCookie}` }
  });
  chainBodies.push(await replay.text());
  assert.equal(replay.status, 400, 'replayed callback rejected (single-use stash)');
  assert.equal(cookiePair(replay, 'sid'), null, 'replay never mints a session');

  // Expiry: force-expire the pending stash between start and callback.
  const startRes = await fetch(`${base}/auth/login/start?name=ReplayT`, { redirect: 'manual' });
  const stashCookie = cookiePair(startRes, 'oidc_stash');
  const authorizeRes = await fetch(startRes.headers.get('location'), { redirect: 'manual' });
  _testExpireStashes();
  const expired = await fetch(authorizeRes.headers.get('location'), {
    redirect: 'manual',
    headers: { Cookie: `oidc_stash=${stashCookie}` }
  });
  chainBodies.push(await expired.text());
  assert.equal(expired.status, 400, 'expired stash rejected');
  // Reset persistence side-effects from this scenario before collision checks.
  flushAll();
  _resetForTests();
  fs.rmSync(path.join(playersDir, 'ReplayT.json'), { force: true });
  console.log('ok — stash single-use + 5min expiry enforced');
}

// ---------------------------------------------------------------------------
// Scenario D — collisions (AC3), both directions.
{
  // Direction 1: same sub rebinds under a DIFFERENT player name.
  const d1 = await driveLogin('FreshT', 'sub-happy-123'); // already owned by OidcT.json
  assert.equal(d1.cbRes.status, 409, 'same sub onto another name rejected');
  flushAll();
  assert.equal(fs.existsSync(path.join(playersDir, 'FreshT.json')), false, 'rejected bind writes nothing');

  // Direction 2: a DIFFERENT sub lands on an already-bound name.
  fs.writeFileSync(path.join(playersDir, 'BoundT.json'),
    JSON.stringify({ name: 'BoundT', oidcSub: 'sub-bound-owner' }, null, 2));
  const d2 = await driveLogin('BoundT', 'sub-intruder');
  assert.equal(d2.cbRes.status, 409, 'different sub onto bound name rejected');
  const rec = JSON.parse(fs.readFileSync(path.join(playersDir, 'BoundT.json'), 'utf8'));
  assert.equal(rec.oidcSub, 'sub-bound-owner', 'existing binding untouched by intruder');
  console.log('ok — collisions: both directions rejected with 409');
}

// ---------------------------------------------------------------------------
// Scenario E — logout clears the session.
{
  const { sid } = await driveLogin('OidcT', 'sub-happy-123'); // own identity rebind is a no-op
  assert.equal((await meOf(sid)).json.verified, true);

  const out = await fetch(`${base}/auth/logout`, {
    redirect: 'manual',
    headers: { Cookie: `sid=${sid}` }
  });
  chainBodies.push(await out.text());
  assert.equal(out.status, 302, 'logout redirects');
  assert.equal(out.headers.get('location'), '/');
  const clear = setCookieRaw(out, 'sid');
  assert.match(clear, /Max-Age=0/, 'logout clears the session cookie');

  const after = await meOf(sid);
  assert.deepEqual(after.json, { verified: false }, 'session destroyed server-side');
  console.log('ok — logout destroys the session and clears the cookie');
}

// ---------------------------------------------------------------------------
// Scenario F — AC4 security sweep: no provider token in ANY client-visible body.
{
  const haystack = chainBodies.join('\n---\n');
  assert.equal(haystack.includes('access_token'), false, "no 'access_token' anywhere");
  assert.equal(haystack.includes('STUB_ACCESS_TOKEN'), false, 'stub access token value leaked');
  assert.equal(haystack.includes('id_token'), false, "'id_token' identifier never serialized");
  for (const jwt of issuedIdTokens) {
    assert.equal(haystack.includes(jwt), false, 'issued ID token JWT leaked into a response');
  }
  console.log(`ok — AC4: ${chainBodies.length} response bodies scanned, zero provider-token leakage`);
}

// --- teardown ----------------------------------------------------------------
server.closeAllConnections?.();
await new Promise((r) => server.close(r));
idp.closeAllConnections?.();
await new Promise((r) => idp.close(r));
flushAll();
_resetForTests();
for (const name of ourNames) fs.rmSync(path.join(playersDir, `${name}.json`), { force: true });
delete process.env.OIDC_ISSUER;
delete process.env.OIDC_CLIENT_ID;
delete process.env.OIDC_CLIENT_SECRET;
delete process.env.OIDC_REDIRECT_URI;

console.log('ok — oidc.test.mjs: stub-IdP flow green (AC1..AC5)');
await waitMs(10);
process.exit(0);
