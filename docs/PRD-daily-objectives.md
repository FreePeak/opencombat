# PRD: Objective-Based Dailies (Cycle 18)

Status: PLANNED (cycle 18)
Mirror of Objective-Based Weeklies (58eb11c, cycle 17) on the Daily Gauntlet
pipeline.

## Problem

The Daily Gauntlet gives players modifiers + streaks, but no per-day goals
beyond "score high". Weeklies got deterministic 2-objective selection with a
sticky within-week merge (cycle 17); dailies have nothing comparable, so the
short-loop retention hook is missing exactly where players visit most often
(every day).

## Solution

Deterministic 2-objective selection keyed by the UTC date, evaluated at every
daily finalize against the run's `{wave, score}`, sticky-merged into the
persisted `player.daily` record (done once true within the day), and exposed
publicly via `/api/daily` (`objectives` definitions + leaderboard rows carry
`objectivesDone`).

## Scope

- `src/shared/sim/dailyRun.js`: pure additions —
  - `DAILY_OBJECTIVES` table (4 rows, thresholds tuned for a single sitting:
    wave_5, wave_8, score_500, score_1200; inclusive `>=` boundaries)
  - `dailyObjectives(dateStrOrSeed)` -> 2 DISTINCT picks via the same LCG
    shape weeklyObjectives uses, seeded by `dailySeed(dateStr)` or raw number;
    never mutates the shared table
  - `evaluateDailyRun(objectives, run)` -> `[{id, done}]`
  - `mergeDailyObjectives(prev, dateStr, results)` -> sticky merge keyed on
    `.date`; same-day keeps done once true per id, new date replaces wholesale
- `src/server/rooms/GameRoom.js`: daily finalize evaluates this run against
  today's picks and stores `objectives` on the merged daily record before
  save (achievements see it too).
- `src/server/http.js`: `/api/daily` response gains
  `objectives: [{id, description}]`; each leaderboard row gains
  `objectivesDone` (count of done===true from the persisted record).
- Tests (`test/dailyObjectives.test.mjs`, red-first): determinism,
  distinctness, numeric-seed path, inclusive boundaries, sticky/new-day merge
  semantics, and an end-to-end finalize pin that the persisted daily blob
  carries `objectives`.

## Out of scope

- LocalRoom/offline wiring (persistence is server-side; matches the weekly
  precedent from cycle 17 where only GameRoom finalizes).
- Achievements predicates over objectives (existing engine already sees the
  merged blob; no new achievements this cycle).
- Any change to weekly objectives or modifier tables.

## Acceptance criteria

1. `dailyObjectives('2026-08-22')` deep-equals itself across calls and yields
   exactly 2 distinct ids from the table; a numeric seed works identically.
2. Boundaries are inclusive: run at exactly the threshold counts as done.
3. Sticky merge: same-date re-run can un-lose a done objective; a new date
   replaces the whole objectives array.
4. A completed daily room run persists `blob.daily.objectives` with one entry
   per picked objective.
5. `/api/daily` exposes the day's objective descriptions and leaderboard
   `objectivesDone`; malformed player files still cannot fail the route.
6. Full gate green: `npm run check && npm test && npm run smoke`.
