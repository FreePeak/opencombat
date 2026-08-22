# PRD: Waves Spectate + Spectator Counts

Status: ACTIVE · Cycle 16 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
Spectating works only for arenas; the LIVE MATCHES panel shows waves/daily/weekly rooms without a watch option and no spectator counts anywhere.

## Solution
Mirror the ArenaRoom spectator branch into GameRoom (all challenge modes included), expose `spectators` per room in /api/rooms, render SPECTATE buttons for joinable-spectrum rows in the client, and show a live spectator count badge while spectating.

## Scope
1. GameRoom.onJoin spectator branch FIRST (before mode/capacity logic): `options.spectator === true` → registerPresence(sid, {name+' (spec)', mode:'spectating', roomId}), log spectate_join, return early (NO PlayerState, NO seat capacity consumption, NO daily/weekly finalize eligibility). onLeave guard mirrors ArenaRoom.
2. /api/rooms listRooms(): add `spectators` count per room from presence registry entries with matching roomId+mode 'spectating' (cheap scan).
3. Client: SPECTATE buttons now also on waves/daily/weekly rows; while spectating show `#spectator-count` chip ("EYES N") refreshed by the existing pollRooms payload (match by roomId); LEAVE unchanged.
4. Tests (`test/wavesSpectate.test.mjs`): playing waves room + joinById spectator → players.size unchanged, presence 'spectating', spectators count in /api/rooms === 1; spectator does not affect daily finalize (force all-PLAYER-dead finalize excludes spectator); leave cleanup.

## Out of scope
World-room spectate (chunked world has no bounded camera), spectator chat.

## Acceptance criteria
- AC1: Spectator joins live waves room: no seat created; /api/rooms spectators>=1 for that roomId.
- AC2: Daily-mode room finalize ignores spectators (streak/bestScore unaffected by their presence).
- AC3: Client renders EYES N chip while spectating; updates after poll cycle.
- AC4: Full gate green; smoke 8/8.

## Fan-out
Single agent (GameRoom+http seam cohesion) + I patch client button condition myself if trivial.
