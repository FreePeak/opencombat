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
