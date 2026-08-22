# PRD: Arena Spectate

Status: ACTIVE · Cycle 9 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
LIVE MATCHES shows running arenas but offers no way to watch. Spectating builds social gravity (audiences make matches matter) and was the #3 retention mechanic from presence research.

## Solution
Join any live arena room by id as a SEATLESS spectator: watch the match via a follow-camera, see round state, LEAVE anytime. Spectators never consume seats, never trigger countdowns, and appear as mode 'spectating' in presence.

## Scope
1. `src/network.js`: `spectateMatch(roomId)` → `currentClient().joinById(roomId, { spectator: true }, WorldState)` (pattern of joinArena ~:124).
2. `src/server/rooms/ArenaRoom.js` onJoin (~:229-288): when `options.spectator === true` — do NOT create a PlayerState seat, do NOT run capacity checks, do NOT call assignArenaTeams(), do NOT trigger auto-start/auto-restart branches; DO `registerPresence(sid, { name: sanitizeName(options.name)+' (spec)', mode: 'spectating', roomId })`; still allow the join (state syncs automatically). onLeave guards seatless spectators.
3. Client (`GameScene.js` + `index.html`):
   - renderRooms(): arena rows get a SPECTATE button; delegated handler routes to spectateMatch(roomId) then wireRoom().
   - update(): when `this.local == null && spectating` — follow-cam on first remotePlayer (local-rig constants), fallback slow orbit around center; HUD minimal; hide input/touch controls.
   - LEAVE pill → room.leave() + full reset to menu.
4. `/api/rooms` unchanged; `/api/players` picks up 'spectating' via presence.
5. Tests (`test/spectate.test.mjs`, waves conventions): playing-phase arena + joinById spectator (no seat created, presence 'spectating'); lobby-phase arena + spectator (no countdown started); leave cleanup.

## Out of scope
Delayed feed/stream-sniping protection, spectator chat, waves/world spectate, spectator counts in rooms list.

## Acceptance criteria
- AC1: Spectator join creates zero PlayerState entries and consumes no capacity.
- AC2: Spectator alone joining a lobby-phase arena does not start the countdown.
- AC3: Spectator sees live state transitions within 2s.
- AC4: Client renders follow-cam without sending input messages.
- AC5: Full gate green (`npm run check`, `npm test`), smoke 8/8.

## Fan-out
- B ∥ C (disjoint files): B = ArenaRoom branch + tests; C = network.js + GameScene rig + panel buttons + index.html
