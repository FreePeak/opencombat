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
