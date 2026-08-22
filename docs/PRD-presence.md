# PRD: Presence Panel

Status: ACTIVE · Cycle 4 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
The game gives no signal it is ALIVE. Visible population is the #1 liveliness cue; empty lobbies kill D1 retention. Players also have zero memory of who they played with.

## Solution
Two surfaces:
1. **Online Now** — a live side panel listing connected players (name + colored presence dot by mode) fed by a new `GET /api/players` endpoint aggregating a server-side presence registry.
2. **Recent Allies** — client-side localStorage list of arena co-participants (name, lastSeenAt, result), capped 20, shown under the panel. Zero server work.

## Scope
1. `src/server/presence.js` (new pure-ish singleton): `registerPresence(sid, {name, mode, roomId})`, `updateMode(sid, mode)`, `removePresence(sid)`, `listPresence()` → sorted [{sid,name,mode,roomId,at}]; Map-backed, O(n) fine at indie scale.
2. Room hooks (2-line each) in GameRoom/WorldRoom/LobbyRoom/ArenaRoom onJoin + onLeave/onDispose: register/remove; updateMode when a player redirects lobby→arena. Names come from options.name (lobby queued map has it).
3. HTTP: `GET /api/players` before catch-all → `{ count, players: [{name, mode}] }` merged view of presence registry (authoritative).
4. Client:
   - `#online-panel` right-side fixed panel mirroring #leaderboard styling (index.html + GameScene render loop every 5s via fetch('/api/players')); dot colors: green=lobby, yellow=world/waves, red=arena; graceful 'offline' state.
   - Recent Allies: after receiving arena gameover/redirect results record opponents to localStorage key 'opengame.recentAllies' (dedupe by name, cap 20, newest first); rendered as a static section under the online panel.
5. Tests (`test/presence.test.mjs` unit: register/update/remove/dedupe/sort; `test/presenceApi.test.mjs` integration: real Server port 0 → join game + world rooms with distinct names → GET /api/players returns both names with correct modes; leave → count drops; existing lobby behavior untouched (arena.test.mjs stays green)).

## Out of scope
Join-in-progress/spectate buttons, idle detection, friends/accounts, cross-server presence, WebSocket push (polling suffices).

## Acceptance criteria
- AC1: Joining waves + world rooms with names A and B → /api/players lists exactly A(waves)+B(world), count=2.
- AC2: A disconnects → count=1 within debounce window.
- AC3: Unit suite covers re-register same sid (upsert, no dupes).
- AC4: Client renders panel entries with correct dot classes (static verification; fetch failure shows OFFLINE state without crashing).
- AC5: All prior features stay green: full `npm run check && npm test`; smoke 8/8; live probe shows own name in /api/players while joined.

## Fan-out plan
- Step A: presence.js + unit tests (I write directly)
- Step B ∥ C: B = room hooks + http endpoint + integration tests; C = client panel + recent allies
