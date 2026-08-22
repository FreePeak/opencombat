# PRD: Career Stats (meta-progression lite)

Status: ACTIVE · Loop cycle F · 2026-08-22
Owner: infinite loop session (agent-driven)
Research basis: docs/vampire-survivors-research.md §2 lesson 7, §6 idea #4
(lean cut)
Depends on: persistence.js (existing), endMatch single-site hook.

## Problem

Runs vanish when they end: nothing accumulates, so there is no "my number
goes up" between sessions. Full meta-progression (unlocks, balance perks) is
roadmap-scale; the lean 80% is a persistent per-player CAREER record surfaced
at results time.

## Solution

Every waves/daily match end records, per player name (persistence.js keyed
exactly like daily streaks):

```json
career: { runs, victories, bestWave, bestScore }
```

- Pure accumulator in shared/sim/careerStats.js (`recordRun`) — monotonic
  maxes for best*, counters otherwise.
- Hooked ONCE inside `GameRoom.endMatch` (covers victory, death, timed,
  daily-finalize endings).
- Surfaced two ways: `careerUpdate` broadcast at match end, and the client
  gameover overlay appends the holder's line.
- Offline LocalRoom: OUT of scope v1 (no server-side store); documented.

## Correctness note (loadPlayer pending-overlay)

finalizeDailyRun calls endMatch then re-loads the player to merge its own
`daily` blob. With two debounced merges in one tick, the second load must see
the first's unflushed data or it clobbers `career`. Fix included:
`loadPlayer` overlays the in-memory pending snapshot before reading the file
(newest-wins), pinned by unit test.

## Scope

1. `src/shared/sim/careerStats.js`: `recordRun(career, run)` pure.
2. persistence.js: loadPlayer pending-overlay (+ test).
3. GameRoom.endMatch: per-player load→record→saveDebounced + `careerUpdate`
   broadcast `[{ sid, name, career }]`.
4. Client GameScene: overlay sub gains the local player's career line.
5. Tests red-first: careerStats unit (4 cases); persistence overlay test;
   waves.test finale extension asserts persisted JSON after flushAll
   (runs/victories/bestWave exact).

## Acceptance criteria

- AC1: After a victory at wave N, `<name>.json`.career equals
  { runs:1, victories:1, bestWave:N, bestScore:<score> } post-flush.
- AC2: A death ending still records runs/best* but victories stays put.
- AC3: Daily finalize does not clobber career (pending-overlay pin).
- AC4: Overlay shows the career line for the local player.
- AC5: Full gate green + smoke + PROGRESS row.

## Post-ship audit note (CYCLE-AF, 2026-08-22)

Spectator mode (PRD-arena-spectate.md) verified compose-clean with career
stats: spectators exist ONLY in ArenaRoom as presence rows (no PlayerState
seat), while endMatch career recording lives exclusively in GameRoom where
every join is a real player. No contamination path exists; no guard needed.

## Post-ship audit note #2 (CYCLE-AQ, 2026-08-22)

OIDC login (PRD-oidc-login.md) verified compose-clean with career stats:
identity binding persists an `oidcSub` FIELD on the existing per-name blob
(no namespace split), so career/daily/weekly records keep their keyed-by-
display-name semantics; same-name collision scenarios are pinned in
oidc.test.mjs. Gate on the combined tree: 115 files ok, 204/204 tests.

## Post-ship audit note #3 (CYCLE-AR, 2026-08-22)

Verified-name join guard (PRD-name-guard.md) audited compose-clean with
career stats: `sanitizeName`/`safeName` mirror untouched (blob keys stable),
and the 4103 guard actively PROTECTS persisted career/daily/weekly blobs
from guest-hijack overwrites of verified-bound names — a direct integrity
upgrade for this feature's storage layer. Combined tree gate: 116 files ok,
205/205 tests.

## Post-ship audit note #4 (CYCLE-AT, 2026-08-22)

Admin/GDPR delete (PRD-admin-gdpr.md era) audited against this feature's
pending-overlay: the delete route calls `cancelPendingSave(name)` BEFORE
unlink ("durable delete"), closing the exact resurrection race an in-flight
debounced career save could otherwise cause. Complementary halves of one
durability guarantee — overlay makes loads see queued writes; cancel makes
deletes forget them.

## Integration audit log (rolling, CYCLE-AU onward)

- 2.18 air-gap vendoring (31990b9): asset-serving only — no career/auth
  interaction. Combined tree gate green (119 files, 207/207). Compose-clean.
- 2.20 waves spectate (701a267): spectators are presence-only (no
  PlayerState seat — first branch in onJoin), so endMatch's career loop
  cannot see them; peer's own test pins 'only the real player finalized'.
  Compose-clean with explicit coverage.
