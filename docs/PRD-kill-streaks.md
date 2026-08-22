# PRD: Kill Streaks + Combat Juice

Status: ACTIVE · Cycle 3 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
Combat feedback is functional but flat: fixed random camera jiggle, no freeze frames, no escalation moment. Kills feel identical whether they're your first or your fifteenth.

## Solution
Two layers, one cycle:

**Layer 1 — Server-authoritative kill streaks.** Rooms track consecutive kills per player (2.5s window, reset on window lapse or death). At MILESTONES ONLY (3/5/10/15/25 → "Killing Spree"/"Rampage"/"Dominating"/"Unstoppable"/"Godlike") rooms broadcast `killStreak { sid, name, count, label }`. All clients toast + pitch-blip; the streaking player gets a small screen-trauma bump.

**Layer 2 — Client juice (render-only, never sim/network).**
- Trauma-based shake: additive accumulator (0..1), offset = maxOffset·trauma², decay 1.5/s; own hit +0.15, kill +0.35, milestone +0.2·tier capped 1.0. Coexists with existing shakeT path.
- Hit-stop: 50ms on own melee-hit-confirm, 110ms on own kill, implemented as FX/anim-timeScale=0 while network state keeps applying (multiplayer-safe; LocalRoom may freeze its sim since it's authoritative-solo).
- Milestone toast reuses banner pattern; SFX pitch rises ~4%/tier via existing WebAudio primitives.
- Damage numbers on milestone kills render 1.5x gold.

## Scope
1. `src/shared/sim/streaks.js` (new pure): `STREAK_WINDOW_MS`, `MILESTONES` table, `registerKill(state, sid, now)` mutating `{count, lastAt}` map, `milestoneFor(count)` → label|null, `resetSid(state, sid)` (death/reset hook).
2. GameRoom + LocalRoom: call registerKill wherever enemy deaths credit a player (combatBook resolveEnemyHit callers / bash strike / volatile AoE if attributed); broadcast/emit `killStreak` on milestone; reset on player death. Parity structural (same shared module).
3. Client (GameScene/entities):
   - trauma accumulator + additive offset injection at the existing post-lerp point (~GameScene.js:1071-1077)
   - hit-stop controller gating FX/anim updates only
   - `#streak-toast` UI + pitch-shifted blip + gold big damage number on milestone
   - subscribe to `killStreak` message (both room types share the message API)
4. Tests (`test/streaks.test.mjs`):
   - Unit: window expiry (kill at t=0 and t=2600ms → reset), non-milestone counts return null, exact milestone labels, death reset.
   - Integration: drive 3 fast kills in GameRoom → one `killStreak` broadcast {count:3}; 4th kill inside window → NO broadcast (next milestone is 5); LocalRoom emits identical payload for same sequence.

## Out of scope
Leaderboard integration of peak streaks, persistence of streak records, new SFX assets (procedural only), vignette, FOV punch.

## Acceptance criteria
- AC1: 3 kills within 2.5s in online waves → exactly one killStreak broadcast, label 'Killing Spree'.
- AC2: Kills spaced >2.5s never broadcast (counter resets silently).
- AC3: LocalRoom same kill sequence produces byte-equal killStreak payload (parity assert).
- AC4: Player death resets their streak (no broadcast on next single kill).
- AC5: Client applies hit-stop/shake without touching state application order — existing suite green proves no regressions.
- AC6: `npm run check && npm test` fully green (new tests included); smoke 8/8; live probe joins and receives no crash on synthetic killStreak message.

## Fan-out plan
- Step A: streaks.js + unit tests (I write directly — contract-critical)
- Step B ∥ C: B = rooms wiring + integration tests; C = client juice (trauma shake, hit-stop, toast, sfx)
