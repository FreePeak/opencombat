# PRD: Daily Gauntlet

Status: ACTIVE · Cycle 1 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
No daily habit loop exists. Retention research ranks deterministic daily challenges + streaks as the highest D7-retention lever for small web games (D1→D7 habit formation via loss aversion).

## Solution
A seeded daily challenge run for the Waves PvE mode. Everyone playing the same UTC day gets identical enemy/wave modifiers (derived from a date hash), making scores comparable. Finishing a run records the score and updates a consecutive-day streak with escalating XP rewards. A public API exposes today's modifiers and the daily leaderboard.

## Scope

### In scope
1. `src/shared/sim/dailyRun.js` — pure module:
   - `utcDateStr(now)` → 'YYYY-MM-DD'
   - `dailySeed(dateStr)` → stable integer (string hash)
   - `dailyModifiers(dateStr|seed)` → deterministic object `{ enemyHpMul, enemySpeedMul, enemyCountBonus, label }` from a fixed table indexed by seed
   - `nextStreak(lastPlayedDate, todayStr, currentStreak)` → yesterday→streak+1, today→unchanged, gap→1
   - `streakRewardXp(streak)` → escalating table capped at 7 days
2. Server (`GameRoom`):
   - Accept `options.mode === 'daily'` on join (default 'waves')
   - When daily: use seeded RNG (LCG from dailySeed) for all position sampling (`randomPos`) so layouts are reproducible; apply dailyModifiers to spawned enemies (hp/speed/count)
   - Run-end rule (daily only): when every connected player is dead simultaneously → `endMatch`, then finalize per-player daily record
   - Persistence (copy WorldRoom load/save pattern): load player file on join; on finalize update `player.daily = { date, bestScore, streak, lastPlayed }`; save debounced
3. HTTP (`src/server/http.js`): `GET /api/daily` → `{ date, seed, modifiers: {label,...}, rewards, leaderboard: [{name, score}...] (top 10 of today's bestDaily, scanned from data/players/*.json) }` — registered before the catch-all
4. Client:
   - Mode picker gains "Daily" card (index.html #mode-picker + GameScene MODES/buildModePicker/onJoinClick branch → joins online game with mode:'daily')
   - Fetch `/api/daily` when Daily selected → HUD banner shows modifier label + your streak/best
   - On run finalize → HUD result text with final score + streak status
5. Tests (`test/daily.test.mjs`, node --test style):
   - dailyRun determinism (same day → same modifiers/seed; different day → different)
   - nextStreak transitions (yesterday/today/gap/null)
   - streakRewardXp monotonic + cap
   - Integration: real Server on port 0, create('game', {name, mode:'daily'}) → enemy hp scaled vs plain waves; /api/daily returns expected shape
6. Offline fallback: selecting Daily with server unreachable degrades to local waves (existing behavior), no streak recorded. Accepted.

### Out of scope
Anti-spoof identity, Postgres adapter, weekly challenges, cosmetics rewards, push notifications.

## Acceptance criteria
- AC1: Two calls to `dailyModifiers(sameDay)` return deep-equal objects; `differentDay` differs.
- AC2: Streak math: played yesterday → +1; already today → unchanged; missed ≥1 day → reset to 1; never played → 1.
- AC3: Joining `game` room with mode:'daily' spawns enemies with hp multiplied by today's enemyHpMul (integration assert).
- AC4: All players dead in daily mode triggers match end and writes `data/players/<name>.json` containing `daily.streak >= 1` and `daily.date == utcDateStr()`.
- AC5: `GET /api/daily` returns 200 with keys date/seed/modifiers/rewards/leaderboard; leaderboard contains a just-finished player's score.
- AC6: Waves mode (non-daily) behavior unchanged: existing 23 test files stay green.
- AC7: `npm run check && npm test` fully green.
- AC8: Live smoke: server boots, `/api/daily` responds, client page loads with Daily mode selectable.

## Verification plan
AC1–5,7 via automated tests; AC6 via full suite; AC8 via live server curl + Playwright-style browser probe (tools/smoke.mjs pattern).

## Fan-out plan
- Step A (sequential prerequisite): dailyRun.js + its unit tests
- Step B ∥ C (parallel after A): B = server wiring (GameRoom + http + integration tests), C = client UI (index.html + GameScene)
