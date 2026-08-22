# PRD: Weekly Gauntlet

Status: ACTIVE · Cycle 7 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
The Daily Gauntlet resets every 24h; there's no longer-horizon ambition. Weeklies give a "boss week" feel via stacked modifiers and a week-scale scoreboard without punishing missed days.

## Solution
A Weekly run reusing the entire Daily pipeline with three deltas: (1) seed source = ISO week key ('2026-W34'), (2) modifiers = deterministic STACK of 3 daily-table rows composed multiplicatively, (3) persistence keeps `{week, bestScore, lastPlayed}` — deliberately NO streak (forgiveness is the mechanic). New room type 'weekly'; new `/api/weekly` endpoint; client card beside Daily.

## Scope
1. `src/shared/sim/weeklyRun.js` (new pure): `utcWeekKey(now)` → 'YYYY-Www' (ISO-8601 week, Monday start); `weeklySeed(weekKey)`; `weeklyModifiers(weekKey|seed)` → composes ELITE_AFFIXES-style table rows: pick 3 distinct daily rows via seed and multiply hpMul/speedMul/countBonus (rounded), label = joined names, description auto-composed; `weeklyRewardXp(bestScore)` flat ladder by score thresholds.
2. Server: GameRoom accepts `options.mode === 'weekly'` → uses weeklyModifiers(utcWeekKey()) + weeklySeed LCG (mirror daily path ~GameRoom.js:90-94); finalize writes `player.weekly = { week, bestScore, lastPlayed }` merging max same-week (mirror daily finalize block); streak logic untouched for weekly. index.js registers `gameServer.define('weekly', GameRoom)`.
3. HTTP `GET /api/weekly`: `{ week, seed, modifiers, rewards, leaderboard(top10 of current week from data/players/*.json weekly.bestScore) }` — mirror /api/daily structure (~http.js:193-227).
4. Client: WEEKLY card in mode picker (subtitle = modifiers.label via fetch('/api/weekly'), offline-degradable); join routes room 'weekly' via network.js joinGame mode mapping; dailyResult banner path reused for weekly finals (server broadcasts same 'dailyResult' event name with a `kind:'weekly'` field).
5. Tests (`test/weekly.test.mjs` unit: ISO week key math incl. year boundary (2026-W1 wraps Dec 29+), determinism, composition values sane (>= single-row magnitudes), reward ladder monotonic; integration in same file: create('weekly') applies stacked hp vs plain wave; forced wipe persists weekly.{week,bestScore}; /api/weekly shape + leaderboard pickup.

## Out of scope
Objective predicates (#2), ladder/grace (#3), cosmetics, cross-mode score unification.

## Acceptance criteria
- AC1: utcWeekKey('2026-12-30') === '2026-W53' or '2027-W1' correctly per ISO rules (test pins actual).
- AC2: Two calls weeklyModifiers(sameWeek) deep-equal; different weeks differ in at least one sampled pair.
- AC3: Joining room 'weekly' spawns enemies with stacked multiplier >= any single row (integration assert).
- AC4: All-dead finalize writes weekly.{week===utcWeekKey(),bestScore>0}; leaderboard reflects it.
- AC5: Full gate green; smoke 8/8; live probe lists weekly room + /api/weekly responds.

## Fan-out
- A: weeklyRun.js + unit tests (I write)
- B ∥ C: B server wiring + integration tests; C client card/subtitle/join routing

---

# ADDENDUM (Cycle 17): Objective-Based Weeklies

## Problem
Weeklies are score-only; multi-objective goals create mastery tiers (research: discovery → mastery → aspirational).

## Solution
Each week deterministically selects 2 OBJECTIVES from a fixed table, checked at every weekly finalize. Progress persists across attempts within the same week (partials kept — never wiped).

## Objective table
| id | desc | predicate(run {wave, score}) |
|---|---|---|
| wave_6 | Reach wave 6 | run.wave >= 6 |
| wave_10 | Reach wave 10 | run.wave >= 10 |
| score_800 | Score 800 in one run | run.score >= 800 |
| score_2000 | Score 2000 in one run | run.score >= 2000 |

Selection: `weeklyObjectives(weekKey)` → 2 distinct entries via LCG from weeklySeed.

## Scope
1. weeklyRun.js additions: WEEKLY_OBJECTIVES table, weeklyObjectives(weekKey), evaluateWeeklyObjectives(objectives, run) → [{id, done}].
2. Finalize (weekly mode only): merge into player.weekly.objectives — per id keep `done` once true (sticky within the week); new week replaces wholesale.
3. /api/weekly adds `objectives: [{id, description}]` (definitions for the week).
4. Leaderboard rows add `objectivesDone` count.
5. Client: weekly subtitle appends objective descriptions; results banner shows "OBJECTIVES n/2".
6. Tests: selection determinism/distinctness; sticky-merge across attempts (attempt1 wave4 → wave_6 not done; attempt2 wave7 → done stays); new week resets; /api/weekly shape.

## ACs
AC1: objectives deterministic + 2 distinct. AC2: sticky merge semantics. AC3: endpoint+leaderboard shape. AC4: full gate green.
