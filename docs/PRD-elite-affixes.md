# PRD: Elite Affixes

Status: ACTIVE · Cycle 2 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
Every enemy is an identical chaser; waves differ only by count/hp numbers. No moment-to-moment variety, no target prioritization decisions, no spike moments worth talking about.

## Solution
Every 5th wave, slot 0 spawns as an ELITE: visually distinct (1.8x scale + red tint) and carrying one random affix that changes how it fights and how you counter it. HUD banner announces it. Killing it pays a reward burst (bonus XP orbs).

## Affix table (server-authoritative)
| Affix | Effect | Counterplay |
|---|---|---|
| Swift | +60% speed | kiting harder; block/bash timing |
| Bulwark | +150% hp, immune to knockback | focus fire, burn DoT |
| Vampiric | heals self 50% of damage dealt | burst it down, avoid melee trades |
| Volatile | on death: AoE explosion (r=3, 25 dmg) after 800ms fuse telegraph | back off after killing blow |

Affix chosen deterministically per wave number (`affixForWave(n)` = table[(n/5) % 4]) so both modes agree without RNG coordination.

## Scope
1. `src/shared/sim/elites.js` (new pure module): ELITE_AFFIXES table, `isEliteWave(n)`, `affixForWave(n)`, `applyElite(state, affixName)` mutating hp/speed/knockback-immunity flags.
2. StateSchema: EnemyState gains `elite: string` ('' = normal). Client Enemy entity reads it → scale 1.8, red tint, gold hp-bar border.
3. Spawn path: BOTH GameRoom.spawnWave (:277) and LocalRoom (:272) — after activateWave, if isEliteWave(n): applyElite(slot0). Shared helper so parity is structural, not duplicated logic.
4. Combat hooks (shared/sim/combatBook.js ctx):
   - Vampiric: in player-damage resolution, elite heals min(50%, cap).
   - Volatile: on elite death, register delayed explosion (reuse burn-tick style timer or room-level pending list); damages players in radius; telegraph = client shows expanding ring via effects layer keyed off enemy death event.
   - Knockback immunity: guard existing knockback application when attacker.elite==='Bulwark' (verify exact knockback site during impl).
5. Reward burst: elite kill grants double killScore XP orbs spawn (existing pickup system).
6. Announcement: reuse banner pattern (GameScene daily-result banner style) — "⚠ ELITE — SWIFT" small toast top-center, auto-hide 4s. Server broadcasts 'eliteSpawn'; LocalRoom calls the same UI directly.
7. Tests (`test/elites.test.mjs`):
   - Unit: isEliteWave (5,10 yes; 4 no), affixForWave deterministic cycling, applyElite stat math incl. Bulwark knockback flag.
   - Integration: waves mode wave 5 → exactly one EnemyState with elite!=='', hp scaled vs non-elite same-wave enemy; LocalRoom wave 5 identical stats (parity assert); Vampiric heal + Volatile explosion damage asserted via sim-level tests mirroring combatBook test style.

## Out of scope
Telegraphed attack patterns (future), phase transitions, new models/animations, arena hazards, boss music.

## Acceptance criteria
- AC1: Wave 5 in online waves mode contains exactly one elite with correct affix-derived stats (integration assert).
- AC2: Offline LocalRoom wave 5 produces byte-equal elite stats (parity assert).
- AC3: Swift elite moves measurably faster than normal enemy in same tick loop.
- AC4: Vampiric elite's hp increases after hitting a player; Volatile death deals AoE damage to a player standing within radius after fuse elapses.
- AC5: Non-elite waves (n%5!==0) contain zero elites; all existing 24 test files stay green.
- AC6: `npm run check && npm test` fully green; smoke 8/8.
- AC7: Client renders elite larger/tinted with banner (static code verification + live probe of EnemyState.elite field over WS).

## Fan-out plan
- Step A: elites.js + unit tests + StateSchema field (prerequisite contract)
- Step B ∥ C after A: B = server+local spawn/combat wiring + integration tests; C = client rendering + banner + explosion FX
