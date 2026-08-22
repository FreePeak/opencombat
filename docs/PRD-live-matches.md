# PRD: Live Match Browser

Status: ACTIVE · Cycle 6 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
Players can't see running matches, so the world feels empty even with people online; joining mid-match is possible but unfair (no catch-up protection).

## Solution
A live room listing endpoint + "LIVE MATCHES" panel section with one-click JOIN for waves rooms, plus a 3-second spawn-protection window for mid-match joins (fairness by construction, per research).

## Scope
1. HTTP `GET /api/rooms`: iterate GameRoom/ArenaRoom/WorldRoom/LobbyRoom static instances → `{ rooms: [{ roomId, mode: 'waves'|'daily'|'arena'|'world'|'lobby', subMode?, players, phase, canJoin }] }`. phase: lobby→'lobby', countdown→'countdown', playing→'live', intermission→'intermission', gameover→'ending'; arena uses its round state if exposed. canJoin = mode waves/daily && matchState playing/intermission && players < cap. Registered before catch-all.
2. GameRoom late-join fairness: in onJoin, when this.mode's match is already 'playing', set invulnUntil = now+3000 (vs existing 1s grace) — reuse existing map, no new mechanics.
3. Client: LIVE MATCHES section under #online-panel rows (same poller family, own 5s fetch): each joinable row shows `mode · players · JOIN` button → reuses existing join flow (joinGame for waves/daily) targeting nothing special (joinOrCreate auto-reuses live rooms — verify and note). Non-joinable rows render muted without button.
4. Tests (`test/roomsApi.test.mjs`): boot real Server port 0 → create two game rooms (one left in countdown, one forced playing) + assert listing shapes/phases/canJoin correctness; late-join while playing → invulnUntil >= now+2500; fresh join keeps 1s grace.

## Out of scope
Arena spectate/delayed feed, spectator camera, cross-server listings, WebSocket push.

## Acceptance criteria
- AC1: /api/rooms lists a live waves room with phase 'live', correct player count.
- AC2: Joining a playing room grants ≥2.5s invulnerability; countdown-phase join keeps legacy 1s.
- AC3: Client renders joinable rows with working buttons; fetch failure degrades silently.
- AC4: Full gate green (`npm run check`, `npm test`), smoke 8/8, live probe shows own room in /api/rooms.

## Fan-out
- B: server (/api/rooms + late-join grace + tests)
- C: client panel section + buttons
