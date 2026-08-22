# PRD: Verified-Name Join Guard

Status: ACTIVE · Cycle 12 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
Deferred from 2.15: a GUEST typing the name of a player whose file carries `oidcSub` continues/overwrites that verified identity's save — a hijack vector.

## Solution
At room join, if the persisted file for `sanitizeName(name)` has an `oidcSub` and the joining client is not that verified session, reject with a typed error the client already surfaces (`src/joinError.js`). Verified sessions bypass via their session cookie → but Colyseus joins can't read cookies, so enforcement = reject ALL room joins for oidcSub-bound names UNLESS the request carries a short-lived join token minted by /auth/callback (session page stashes it in memory and passes it as a join option).

## Scope
1. `/auth/callback` also returns (same-page bootstrap) `GET /auth/join-ticket` → `{ ticket }` for the current verified session (single-use, 60s TTL, bound to playerName).
2. Rooms GameRoom/ArenaRoom/WorldRoom onJoin guard (ONE shared helper `assertNameJoinable(name, options)` in `src/server/auth/oidc.js`): loadPlayer(sanitized)?.oidcSub exists && options.joinTicket !== valid-unconsumed-ticket-for-that-name → throw Colyseus error code 4103 'name locked by verified account'.
   - Guests using unbound names: unchanged.
   - Verified flow: after login=ok the client fetches /auth/join-token once per join attempt and passes it in join options.
3. Client: when /api/me says verified, before every join call fetch join-ticket and include it in options (network.js threads `joinTicket` through joinGame/joinWorld/joinArena).
4. Tests (`test/nameGuard.test.mjs`): bound name + no ticket → rejected 4103; bound name + valid ticket → joins; unbound name + no ticket → joins (guest isolation); ticket single-use (second join with same ticket rejected); all three room types covered at least once.

## Out of scope
Rename flows, admin unlock, rate-limit hardening beyond existing limiter.

## Acceptance criteria
- AC1: Guest cannot play under a verified-bound name (all 3 room types).
- AC2: Verified holder plays normally via ticket.
- AC3: Unbound names behave exactly as before.
- AC4: Full gate green; smoke 8/8.

## Fan-out
Single agent (auth seam cohesion): server helper+routes+guards+tests; then I patch network.js/GameScene join threading myself if needed.
