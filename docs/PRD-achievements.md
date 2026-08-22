# PRD: Achievements

Status: ACTIVE · Cycle 8 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
Progression exists (levels, career stats, daily/weekly records) but nothing commemorates milestones. Visible accomplishment extends the retention curve (retention research #5).

## Solution
A pure achievement engine over the already-persisted player blob (`career`, `daily`, `weekly`): at every finalize path, evaluate predicates, persist newly-unlocked ids into `player.achievements[]`, and broadcast `achievementsUnlocked` so clients toast. Zero new persistence machinery.

## Achievement table (v1)
| id | name | Predicate (over saved blob) |
|---|---|---|
| first_run | First Steps | career.runs >= 1 |
| veteran | Veteran | career.runs >= 10 |
| centurion | Centurion | career.runs >= 50 |
| first_win | First Blood | career.victories >= 1 |
| wave_5 | Ridge Runner | career.bestWave >= 5 |
| wave_9 | Ashwalker | career.bestWave >= 9 |
| wave_12 | Warlord's End | career.bestWave >= 12 |
| score_2k | Score Hunter | career.bestScore >= 2000 |
| daily_3 | Committed | daily.streak >= 3 |
| weekly_1500 | Weekly Warrior | weekly.bestScore >= 1500 |

## Scope
1. `src/shared/sim/achievements.js` (new pure): ACHIEVEMENTS table, `evaluateAchievements(savedBlob)` → { unlocked: [ids], newIds } comparing against `savedBlob.achievements || []`; never mutates input.
2. GameRoom: at the existing finalize sites (career endMatch block ~:620 AND daily/weekly finalize), call evaluate with the just-merged saved record; if newIds.length → save merged `achievements` array and `broadcast('achievementsUnlocked', { ids: newIds })`. One helper to avoid duplication across sites.
3. Client: handler near killStreak/eliteSpawn handlers → reuse #streak-toast styling for an "ACHIEVEMENT UNLOCKED — <name>" toast (gold), auto-hide 4s.
4. Tests (`test/achievements.test.mjs`): table shape-valid (unique ids, string names); evaluate truth-table (empty blob → first_run only; thresholds boundary exact; already-unlocked excluded from newIds but present in unlocked); integration: drive one gameover in a real room with forced career state → broadcast observed + data/players/<name>.json contains achievements including expected id.

## Out of scope
Achievement points/score, retroactive UI gallery page, rewards beyond XP-less cosmetics, notifications outside the toast.

## Acceptance criteria
- AC1: Empty blob evaluates exactly ['first_run'] as new.
- AC2: Threshold boundaries are inclusive (runs===10 unlocks veteran).
- AC3: Re-evaluation yields no duplicate unlocks; order stable.
- AC4: Real-room gameover persists achievements array + emits broadcast once per unlock batch.
- AC5: Full gate green; smoke 8/8.

## Fan-out
- A: achievements.js + unit tests (I write)
- B ∥ C: B = GameRoom wiring + integration test; C = client toast
