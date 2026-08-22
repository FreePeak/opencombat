// OIDC Authorization-Code + PKCE login (PRD-oidc-login.md) — BFF pattern.
//
// OFF unless configured: with any of OIDC_ISSUER / OIDC_CLIENT_ID /
// OIDC_CLIENT_SECRET absent, buildAuthRoutes registers NOTHING and guest play
// is byte-identical (AC1). When enabled:
//   - GET /auth/login/start?name=... : stashes {state, nonce, codeVerifier,
//     playerName} server-side, keyed to a one-time pre-session cookie (32B
//     base64url), then 302s to the issuer's authorization endpoint with
//     PKCE(S256)+state+nonce.
//   - GET /auth/callback : consumes the stash (single-use, 5 min TTL),
//     validates the returned state, exchanges the code with the verifier and
//     validates the ID token (iss/aud/exp/nonce) via openid-client's
//     authorizationCodeGrant + JWKS. The verified `sub` binds to the player
//     file data/players/<name>.json as `oidcSub` — REJECTED with 409 if that
//     file is already bound to a different sub, or if the sub is already
//     bound to a different player. Issues an opaque HttpOnly session cookie.
//   - GET /auth/logout : destroys the session, clears the cookie.
//   - GET /api/me : {name, verified:true} for a live session, else
//     {verified:false}.
//   - GET /auth/join-token : {ticket} for the live session (single-use,
//     60s TTL, bound to playerName) — Colyseus joins cannot read cookies, so
//     the verified client passes it as a join option (PRD-name-guard.md).
//
// SECURITY (AC4): provider tokens NEVER leave this module's memory — no
// id_token/access_token is ever serialized into a response; the browser only
// ever holds opaque cookies marked HttpOnly; SameSite=Lax; Path=/.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  discovery,
  buildAuthorizationUrl,
  authorizationCodeGrant,
  calculatePKCECodeChallenge,
  randomPKCECodeVerifier,
  randomState,
  randomNonce,
  allowInsecureRequests
} from 'openid-client';
import { SERVER } from '../config.js';
import { loadPlayer, savePlayerDebounced } from '../persistence.js';
import { log, warn } from '../log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');

// Login attempts expire after 5 minutes and are single-use.
const STASH_TTL_MS = 5 * 60 * 1000;
const PRESESSION_COOKIE = 'oidc_stash';
const SESSION_COOKIE = 'sid';

// In-memory stash of in-flight logins: preSessionId -> entry. Single process
// assumption, same as the presence registry and rate limiter buckets.
const stash = new Map();
// Live sessions: sessionId -> {sub, iss, playerName}.
const sessions = new Map();

// Join tickets (PRD-name-guard.md): playerName -> {ticket, expiresAt, used}.
// One live ticket per bound name (a fresh mint replaces the previous one);
// single-use, 60s TTL. Single process assumption, same as the maps above.
const JOIN_TICKET_TTL_MS = 60 * 1000;
const joinTickets = new Map();

// Tests-only override of oidcEnabled(): null defers to env. Production paths
// never touch this.
let forcedEnabled = null;

export function _setOidcEnabledForTests(value) {
  forcedEnabled = typeof value === 'boolean' ? value : null;
}

export function oidcEnabled() {
  if (forcedEnabled !== null) return forcedEnabled;
  return Boolean(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET);
}

// Mirrors GameRoom.sanitizeName (display form); persistence applies its own
// filesystem-safe mapping on top when touching files.
const sanitizeName = (raw) => String(Array.isArray(raw) ? raw[0] : raw ?? '').trim().slice(0, 16) || 'player';

// persistence.safeName twin: the exact key a name maps to on disk.
const fsSafeName = (raw) =>
  String(raw ?? '').trim().slice(0, 16).replace(/[^a-zA-Z0-9_-]/g, '_') || 'player';

const appUrl = () => (process.env.APP_URL || `http://localhost:${SERVER.port}`).replace(/\/+$/, '');
const redirectUri = () => process.env.OIDC_REDIRECT_URI || `${appUrl()}/auth/callback`;

// discovery() hits the network once per process; cache the client config.
let clientConfigPromise = null;
function getClientConfig() {
  if (!clientConfigPromise) {
    const issuer = new URL(process.env.OIDC_ISSUER);
    // openid-client refuses plain HTTP by default; allow it only when the
    // configured issuer itself asks for http (self-hosted/dev issuers).
    const insecure = issuer.protocol === 'http:';
    clientConfigPromise = discovery(
      issuer,
      process.env.OIDC_CLIENT_ID,
      process.env.OIDC_CLIENT_SECRET,
      undefined,
      insecure ? { execute: [allowInsecureRequests] } : undefined
    );
  }
  return clientConfigPromise;
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

const cookieStr = (name, value, maxAgeSec) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${maxAgeSec !== undefined ? `; Max-Age=${maxAgeSec}` : ''}`;

function sweepStash() {
  const now = Date.now();
  for (const [key, entry] of stash) {
    if (entry.expiresAt <= now) stash.delete(key);
  }
}

function sweepJoinTickets() {
  const now = Date.now();
  for (const [name, entry] of joinTickets) {
    if (entry.used || entry.expiresAt <= now) joinTickets.delete(name);
  }
}

/** Mint a single-use, 60s join ticket bound to the session's playerName
 *  (PRD-name-guard.md). Returns null when the session is unknown. */
export function mintTicketForSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  sweepJoinTickets();
  const ticket = crypto.randomBytes(32).toString('base64url');
  joinTickets.set(session.playerName, {
    ticket,
    playerName: session.playerName,
    expiresAt: Date.now() + JOIN_TICKET_TTL_MS,
    used: false
  });
  return ticket;
}

/**
 * Verified-name join guard (PRD-name-guard.md): every room calls this in
 * onJoin before creating a seat. Enforcement is tied to the OIDC feature —
 * with auth disabled (or for unbound names) behavior is byte-identical.
 * A name whose persisted player file carries `oidcSub` rejects guest joins
 * unless the join options carry that name's valid, unused, unexpired ticket.
 * Mirrors how rooms reject full arenas (room-level throw from onJoin); the
 * code 4103 lets the client surface a typed message via src/joinError.js.
 */
export function assertNameJoinable(name, options = {}) {
  if (!oidcEnabled()) return; // guest-only deployments keep zero behavior change
  const sanitized = sanitizeName(name);
  const saved = loadPlayer(sanitized);
  if (!saved?.oidcSub) return; // unbound names are never locked

  sweepJoinTickets();
  const entry = joinTickets.get(sanitized);
  if (
    entry && !entry.used && entry.expiresAt > Date.now() &&
    entry.playerName === sanitized &&
    typeof options.joinTicket === 'string' && options.joinTicket === entry.ticket
  ) {
    entry.used = true; // strictly single-use
    log('join_ticket_used', { name: sanitized });
    return;
  }

  const err = new Error('name locked by verified account');
  err.code = 4103;
  throw err;
}

/** Scan player files for an existing binding of `sub`; returns the owning
 *  filename key or null. One identity -> one player file. */
function findSubOwner(sub) {
  const dir = path.resolve(root, SERVER.persistence?.dir || 'data/players');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return null; } // no data dir yet
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (rec?.oidcSub === sub) return file.replace(/\.json$/, '');
    } catch {} // malformed/partial file — skip, never fail login over it
  }
  return null;
}

/**
 * Register the auth routes on `app`. MUST run before the catch-all 404.
 * Registers nothing when OIDC env config is absent (guest isolation, AC1).
 */
export function buildAuthRoutes(app) {
  if (!oidcEnabled()) return;

  // --- Step 1: begin login --------------------------------------------------
  app.get('/auth/login/start', async (req, res) => {
    try {
      const playerName = sanitizeName(req.query.name);
      const codeVerifier = randomPKCECodeVerifier();
      const state = randomState();
      const nonce = randomNonce();
      sweepStash();
      const preSessionId = crypto.randomBytes(32).toString('base64url');
      stash.set(preSessionId, { state, nonce, codeVerifier, playerName, expiresAt: Date.now() + STASH_TTL_MS });

      const redirectTo = buildAuthorizationUrl(await getClientConfig(), new URLSearchParams({
        redirect_uri: redirectUri(),
        scope: 'openid',
        state,
        nonce,
        code_challenge: await calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256'
      }));

      res.setHeader('Set-Cookie', cookieStr(PRESESSION_COOKIE, preSessionId, Math.floor(STASH_TTL_MS / 1000)));
      res.redirect(302, redirectTo.toString());
    } catch (err) {
      warn('oidc_start_failed', { error: err?.message });
      res.status(502).json({ error: 'login unavailable' });
    }
  });

  // --- Step 2: provider callback -------------------------------------------
  app.get('/auth/callback', async (req, res) => {
    // One-time stash consumption up front: replayed callbacks never re-bind.
    const preSessionId = getCookie(req, PRESESSION_COOKIE);
    const entry = preSessionId ? stash.get(preSessionId) : null;
    if (preSessionId) stash.delete(preSessionId);

    const reject = (status, msg) => res.status(status).json({ error: msg });
    try {
      if (!entry || entry.expiresAt < Date.now()) return reject(400, 'expired or unknown login attempt');
      if (!req.query.state || String(req.query.state) !== entry.state) return reject(400, 'state mismatch');

      // Full exchange + ID token validation (iss exact / aud / exp / nonce)
      // inside the library; JWKS fetched from the discovered jwks_uri.
      const currentUrl = new URL(req.originalUrl, 'http://callback.internal'); // only searchParams are read
      const tokens = await authorizationCodeGrant(await getClientConfig(), currentUrl, {
        pkceCodeVerifier: entry.codeVerifier,
        expectedState: entry.state,
        expectedNonce: entry.nonce
      });
      const claims = tokens.claims();
      const sub = claims?.sub;
      if (!sub || typeof sub !== 'string') return reject(401, 'id token missing subject');

      // Binding rules (PRD AC3, both directions):
      const key = fsSafeName(entry.playerName);
      const owner = findSubOwner(sub);
      if (owner && owner !== key) {
        return reject(409, 'identity already bound to another player');
      }
      const existing = loadPlayer(entry.playerName);
      if (existing?.oidcSub && existing.oidcSub !== sub) {
        return reject(409, 'player already bound to another identity');
      }

      savePlayerDebounced(entry.playerName, { ...(existing ?? {}), oidcSub: sub });

      const sessionId = crypto.randomBytes(32).toString('base64url');
      sessions.set(sessionId, { sub, iss: claims.iss, playerName: entry.playerName });
      log('oidc_login', { name: entry.playerName });

      res.setHeader('Set-Cookie', [
        cookieStr(SESSION_COOKIE, sessionId),
        cookieStr(PRESESSION_COOKIE, '', 0) // consume the pre-session cookie
      ]);
      res.redirect(302, '/?login=ok');
    } catch (err) {
      warn('oidc_callback_failed', { error: err?.message });
      res.status(401).json({ error: 'login failed' });
    }
  });

  // --- Logout ---------------------------------------------------------------
  app.get('/auth/logout', (req, res) => {
    const sessionId = getCookie(req, SESSION_COOKIE);
    if (sessionId) sessions.delete(sessionId);
    res.setHeader('Set-Cookie', cookieStr(SESSION_COOKIE, '', 0));
    res.redirect(302, '/');
  });

  // --- Who am I ---------------------------------------------------------------
  app.get('/api/me', (req, res) => {
    const session = sessions.get(getCookie(req, SESSION_COOKIE));
    if (session) return res.json({ name: session.playerName, verified: true });
    res.json({ verified: false });
  });

  // --- Join ticket (PRD-name-guard.md) ---------------------------------------
  // The verified page fetches this once per join attempt and passes
  // { joinTicket } in the Colyseus join options (joins cannot read cookies).
  app.get('/auth/join-token', (req, res) => {
    const sessionId = getCookie(req, SESSION_COOKIE);
    const ticket = sessionId ? mintTicketForSession(sessionId) : null;
    if (!ticket) return res.status(401).json({ error: 'not authenticated' });
    res.json({ ticket });
  });
}

/** Tests-only: force-expire every pending stash entry. */
export function _testExpireStashes() {
  for (const entry of stash.values()) entry.expiresAt = Date.now() - 1;
}

/** Tests-only: fabricate a live session for `playerName` and return its id,
 *  so tests can mint real join tickets without driving the IdP flow. */
export function _testSeedSession(playerName) {
  const sessionId = crypto.randomBytes(16).toString('base64url');
  sessions.set(sessionId, { sub: `sub-test-${playerName}`, iss: 'test', playerName });
  return sessionId;
}
