# PRD: OIDC Login Option

Status: ACTIVE · Cycle 11 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
Players are name-only; anyone can type any name and continue someone's save. Roadmap 2.1 wants an optional verified identity without touching guest play.

## Solution
BFF-pattern OIDC Authorization-Code + PKCE login, OFF unless configured (`OIDC_ISSUER` etc. absent → zero behavior change). Provider tokens stay server-side; browser gets an opaque HttpOnly session cookie. Verified subject binds to a player file via stable `sub`; `/api/me` exposes `{name, verified}`.

## Scope
1. Dep: add `openid-client` (v6).
2. `src/server/auth/oidc.js` (new): config loader (env OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET/OIDC_REDIRECT_URI/APP_URL) → `oidcEnabled()` boolean; `buildAuthRoutes(app)` registering:
   - `GET /auth/login/start`: stash `{state, nonce, codeVerifier}` server-side keyed to pre-session cookie; 302 → issuer authorize URL
   - `GET /auth/callback`: validate state → exchange code (S256 PKCE) → verify ID token (iss/aud/exp/nonce via library discovery/JWKS) → userinfo sub → issue opaque session cookie (32B base64url, HttpOnly SameSite=Lax Path=/) mapping to `{sub, iss, playerName}`
   - `GET /auth/logout`: destroy session, clear cookie
   - `GET /api/me`: `{name, verified:true}` | `{verified:false}`
3. Binding: callback takes `playerName` from a short-lived signed continuation param chosen on /login/start form (name input); writes `oidcSub` into `data/players/<name>.json`; REJECT if that file already has a different oidcSub.
4. Client (after server lands): "Sign in" link on login card shown only when /api/me reports feature availability (add `oidcEnabled` to an existing bootstrap endpoint or /api/me 401 body); post-login redirect back to menu shows verified badge next to name.
5. Tests (`test/oidc.test.mjs`): in-process STUB IdP (node:crypto RSA keypair → JWKS endpoint, discovery doc, /authorize issuing code bound to stored verifier challenge, /token verifying PKCE + returning RS256 ID token) driving the FULL browser-less flow via fetch with cookie jar semantics (manual Set-Cookie capture):
   - disabled-by-default: routes return 404/feature-off when env absent; all existing suites untouched
   - happy path: start → callback → me returns {name, verified:true}; player file gains matching oidcSub
   - collision: second login same sub different name rejected; different sub existing bound name rejected
   - logout clears session

## Out of scope
Room-join guest-collision enforcement (next cycle — documented hijack risk until then), refresh tokens, IdP end_session redirect, account linking UI.

## Acceptance criteria
- AC1: Unconfigured → all new routes inert; `npm test` unchanged-green proves guest isolation.
- AC2: Happy-path stub flow yields verified session + persisted oidcSub.
- AC3: Both collision directions rejected with 4xx.
- AC4: Session cookie HttpOnly/SameSite=Lax; no provider token ever serialized to the client (assert response bodies).
- AC5: Full gate green incl. new tests; smoke 8/8.

## Fan-out
- Step B: single strong agent — server flow + stub IdP + tests (cohesive security surface)
- Step C (after B): client sign-in link + verified badge
