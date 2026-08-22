# PRD: Enemy Archetypes

Status: PLANNED · Research cycle R3 · 2026-08-22
Owner: hackathon loop (agent-driven)
Research basis: docs/vampire-survivors-research.md §2 lesson 2, §6 idea #2
Depends on: Elite Affixes (cycle 2.6) landing first — shared files
(GameRoom/LocalRoom chase loops, StateSchema) are hot until its commit.

## Problem

Every enemy is an identical nearest-target chaser; waves differ only by count
and HP numbers. There are no target-prioritization decisions, no movement
readability, no reason to reposition beyond kiting a blob. This is the
highest-severity gameplay gap in the R3 audit (docs/vampire-survivors-research.md
gap analysis) and the same problem statement Elite Affixes opens with —
affixes add spike moments every 5th wave, archetypes fix the other ~90% of
the moment-to-moment play.

## Solution

From wave 3 onward, non-elite slots carry one of three ARCHETYPES assigned
deterministically from (wave, slot) so online GameRoom and offline LocalRoom
agree without RNG coordination (same structural-parity trick as affixForWave):

| Archetype | Tag | Stat deltas | Behavior | Counterplay |
|---|---|---|---|---|
| Rusher | `'rusher'` | speed ×1.4, hp ×0.75 | closes distance fast, wide flanking arc | hit-stun trades, block timing |
| Tank | `'tank'` | hp ×2.0, speed ×0.7, knockback ×0.25 | slow wall of meat; soaks focus fire | burn DoT, bash, don't get cornered |
| Chaser (default) | `''` | none | current behavior | unchanged |

Shooter is explicitly OUT of this cycle (see Out of scope): real enemy-fired
projectiles need an inverted collision branch in projectileLoop plus client
render work; ship the movement-variety core first.

Waves 1–2 stay pure chasers (onboarding ramp). Assignment:
`archetypeForSlot(wave, slot)` — waves < 3 return ''; else deterministic
pattern over `(wave + slot) % 5`: 0–1 → rusher, 2 → tank, else chaser.
Elites always win the visual/stat race: if a slot is marked elite by
applyElite, its elite stats apply on TOP of archetype base (compose: elite
multipliers multiply archetype multipliers; speedMul/hpMul compose
multiplicatively, documented order: archetype first, then elite).

## Scope

1. `src/shared/sim/archetypes.js` (new pure module, no imports — mirrors
   elites.js contract):
   - `ARCHETYPES` table `{ name, hpMul, speedMul, knockbackMul }`
   - `archetypeForSlot(wave, slot)` deterministic selector
   - `archetypeByName(tag)`
   - `applyArchetype(state, tag)` stamping derived max-hp expectation is NOT
     needed — consumers look up multipliers per-tick via tag lookup exactly
     like elites (documented server/client contract header).
2. StateSchema: `EnemyState.archetype: string` (`''` default).
3. Spawn path BOTH rooms: after activateWave + elite marking, iterate live
   slots: skip slot 0 on elite waves (elites keep their own identity unless
   we later decide composition — v1: elite slot never gets an archetype,
   keeping the spike readable); others get `state.archetype =
   archetypeForSlot(n, i)`. GameRoom.spawnWave + LocalRoom._spawnWave call a
   SHARED helper exported from archetypes.js so parity is structural.
4. Chase loops BOTH rooms: speed multiplier resolved once per enemy per tick:
   `SERVER.enemy.speed * roomMul * archetypeByName(e.archetype).speedMul`.
   Tank/rusher flank: rushers add a small perpendicular sine offset while d >
   contactRange (deterministic from now+enemy id — no per-enemy phase state).
   v1 keeps tanks/chasers on straight-line pursuit.
5. Knockback: combatBook.knockbackAgainst extended to consult
   archetype knockbackMul when no elite override applies (elite immune still
   wins). Bash-cone strike sites route through the same helper (already the
   pattern).
6. HP math: strikeEnemy/damage sites are agnostic (they subtract from
   state.hp stamped at spawn) — spawn stamps `hp = ceil(baseHp *
   archetype.hpMul [* daily mods])`, mirroring how elite effHp composes
   today (archetype applied FIRST, then elite multiplier on top).
7. Client: Enemy entity reads `state.archetype` → subtle tint per archetype
   (rusher: cyan-ish, tank: slate/green) + scale nudge (tank 1.15×, rusher
   0.9×) UNDER the elite 1.8× treatment; dispose-safe clone pattern already
   in Enemy.js is reused. No new HUD surface (no banner — these are ambient,
   not spikes; banner stays elite-only).
8. Tests (red-first, node:test):
   - Unit `test/archetypes.test.mjs`: table shape, archetypeForSlot
     determinism + wave<3 empty + elite-slot exclusion helper, multiplier
     lookups, unknown-tag no-op.
   - Integration `waves.test.mjs` extension: wave 3 contains ≥1 rusher AND
     ≥1 tank by tag with hp scaled vs chaser same-wave; LocalRoom byte-equal
     parity assert (same tags, same hp values).
   - Parity pin: chase-loop speed assert — rusher closes a fixed gap faster
     than chaser over identical dt budget in both rooms.

## Out of scope (this cycle)

- Shooter archetype / enemy-fired projectiles (next cycle; ownerIsPlayer=false
  branch in projectileLoop + client shard render).
- New models/animations (tints + scale only, matching elite approach).
- Boss-tier stat scaling, telegraphed attack patterns (elite PRD future item),
  archetype-specific AI coordination (flanking formations).

## Acceptance criteria

- AC1: Wave 3 in waves mode contains at least one rusher-tagged and one
  tank-tagged EnemyState with hp exactly ceil(baseHp × hpMul) (integration
  assert, both rooms identical).
- AC2: Waves 1–2 contain zero tagged enemies (onboarding unchanged).
- AC3: Rusher moves measurably faster than a same-wave chaser under identical
  sim ticks in BOTH rooms (parity assert).
- AC4: Tank takes reduced knockback (≤25% of chaser displacement) and elite
  Bulwark immunity still wins when composed.
- AC5: Elite waves: slot 0 remains archetype-free; elite stats unaffected.
- AC6: Full gate green: `npm run check && npm test` (+ smoke before push);
  PROGRESS.md row updated with evidence.
