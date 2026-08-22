# PRD: Objective HUD (Cycle 23)

Status: PLANNED (cycle 23) — completes the loop started by cycle-17 weeklies
and cycle-18 dailies: those objectives ship server-side but render NOWHERE in
the client (verified: `fetchDailyInfo`/`fetchWeeklyInfo` discard the
`objectives` array).

## Problem

Players cannot see what the day's or week's objectives ARE until they finish
a run, and never see progress mid-run. Retention hooks that are invisible
do not retain.

## Solution

1. Machine-readable targets: `DAILY_OBJECTIVES` / `WEEKLY_OBJECTIVES` rows
   gain `{ kind: 'wave'|'score', value: N }`; `/api/daily` + `/api/weekly`
   pass `target` through alongside id/description.
2. Pure evaluator `objectiveProgress(targets, {wave, score})` in
   shared/sim/objectivesHud.js -> [{id, done}] (same inclusive >= semantics).
3. Client: menu daily/weekly card subtitles append the day's goal lines;
   during daily/weekly matches a compact HUD chip lists the 2 objectives
   with live check/cross marks updated from synced wave/score.

## Scope

- src/shared/sim/dailyRun.js, weeklyRun.js: add kind/value to rows.
- src/server/http.js: include target in the exposed objectives arrays.
- src/shared/sim/objectivesHud.js (new) + tests.
- src/scenes/GameScene.js: subtitle lines + in-match chip lifecycle
  (created for mode daily/weekly, hidden otherwise).

## Out of scope

- Push notifications, rewards beyond existing finalize XP.
- Waves/arena modes (no objectives there).

## Acceptance criteria

1. Every DAILY/WEEKLY_OBJECTIVES row carries kind in {'wave','score'} and a
   positive integer value consistent with its predicate boundary.
2. objectiveProgress is deterministic, inclusive at boundaries, and agrees
   with the server-side evaluateDailyRun/evaluateWeeklyRun truth tables.
3. /api/daily + /api/weekly expose target objects; no predicate leakage.
4. Chip appears only in daily/weekly matches; menu subtitles degrade
   gracefully offline (existing 'offline' text untouched).
5. Full gate green: npm run check && npm test && npm run smoke.
