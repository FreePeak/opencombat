# PRD: Adaptive Music Director

Status: ACTIVE · Cycle 5 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
Music is a static two-oscillator pad at constant volume regardless of gameplay. No tension arc: wave clears, streaks, and elite spawns sound identical to idle wandering.

## Solution
A procedural intensity-layered music system: a pure state machine maps gameplay signals to a target intensity tier; a lookahead scheduler crossfades synthesized layers (calm pad / combat pulse / hats / riser) on bar boundaries. All synthesis reuses the existing SoundManager context/master (mute+volume keep working). Zero audio assets.

## Intensity tiers
| Tier | Trigger | Layers |
|---|---|---|
| 0 calm | lobby/countdown/gameover | pad only |
| 1 explore | playing, hp>66%, no elite | pad + slow pulse bass |
| 2 combat | playing, hp≤66% or recent damage (<4s) | pad+pulse faster + noise hats |
| 3 threat | elite alive OR streak milestone in last 6s | all + riser sweep once on entry |
Paused → freeze current tier (no decay).

## Scope
1. `src/audio/musicDirectorCore.js` (new PURE, I write): tiers table, `decideTier({matchState, paused, hpPct, lastDamageAt, eliteActive, lastMilestoneAt}, now)` → 0..3, `barBoundary(barMs, now)` → next boundary timestamp, `hysteresisOk(current, target, sinceChangeAt, minHoldMs)`. Injected clock only.
2. `src/audio/MusicDirector.js` (new): class taking ({sound}) — builds layer gain nodes off sound.ctx/sound.master; looping noise buffer created ONCE; `setSignals(...)` called from GameScene each frame (cheap field copy); internal rAF-less tick via the scene's update loop calling `director.update(nowMs)`; quantized crossfades (~120ms) scheduled against ctx.currentTime; riser = filtered noise sweep on tier-3 entry.
3. SoundManager: expose nothing new if ctx/master are already public fields (they are); add `stopPad()` guard reuse if trivial.
4. GameScene hooks (narrow, conflict-minimized): instantiate director after sound.init() in onJoinClick gesture path; per-frame `setSignals` from existing computed values (paused :~1171, me.hp pct ~:1408-1410, matchState edge var, lastHp diff site); feed eliteActive from eliteSpawn toast visibility window; lastMilestoneAt from killStreak handler.
5. Tests (`test/musicDirector.test.mjs`): tier decision matrix (all triggers incl. hysteresis hold + expiry), barBoundary math across wraparound, pause freeze behavior. No AudioContext needed.

## Out of scope
Spatialized cues (future cycle), sample assets, volume UI changes, mobile iOS unlock quirks beyond existing gesture init.

## Acceptance criteria
- AC1: decideTier returns correct tier for a 12-row truth table including hysteresis min-hold.
- AC2: Director never throws when AudioContext missing (headless import safe).
- AC3: Mute still silences everything (layers route through master).
- AC4: Existing suite green; smoke 8/8; live boot shows no console errors with sound enabled.
