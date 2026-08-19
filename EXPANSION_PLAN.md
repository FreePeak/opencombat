# Ashfall — Expansion Plan

A 7-phase roadmap to grow the arena survivor into a souls-like MMORPG-lite:
ranged normals, per-class signature skills, level-up upgrade cards, a PvP
arena with matchmaking, and a chunked infinite open world. Each phase is
self-contained and lands on its own commit so work can be spread across
sessions.

Conventions: TDD (red test first), keep `npm test` and `npm run check` green
at the end of every phase. Per-session checklist:

1. `git log --oneline -5` — where did we leave off?
2. `npm test` baseline — must be green before touching anything.
3. Implement the next phase, starting with its red test.
4. `npm run check && npm test` — green again.
5. Real-browser smoke for any client change (see
   `verify-client-changes-in-real-browser` memory: curl/Node checks have
   missed browser-only boot crashes twice).

---

## Phase 0 — Shared combat core + test runner (foundation) ✅ DONE (db7b4a2)

Extract the duplicated combat logic so every later phase's rule change is
edited once, not twice (GameRoom.js AND LocalRoom.js currently mirror every
rule; offline parity is a tested contract).

- Switch the test script from the `&&` chain to the built-in runner:
  `node --test test/` (Node ≥ 18.13).
- Add `tools/check.mjs`: a glob over `src/**` + `test/**` that runs
  `node --check` on every JS/MJS file — replaces the hardcoded `&&` chain in
  the `check` script too.
- Extract `src/shared/combat.js` from GameRoom.js: the pure math both rooms
  duplicate —
  - melee arc test + enemy-hit list (`meleeHits`),
  - block arc test (`blockedHit`),
  - enemy strike (hp drop + knockback clamp, `strikeEnemy`),
  - player strike (hp drop + knockback clamp, `strikePlayer`),
  - facing vector helper.
- GameRoom.js and LocalRoom.js consume the shared module; behavior identical.
- Add `test/combatShared.test.mjs` proving the shared math (arc/block/knockback).
- Rename Spikeman → Demon: `CONFIG.characters` key `spike` → `demon`, label
  `Spike Man` → `Demon`. GLB file stays `spike.glb`; character index 3 and
  localStorage (index-based) unchanged. Update README roster mentions.

## Phase 1 — Ranged normals (projectiles) ✅ DONE

No projectile system exists yet; this phase introduces the first one.

- `src/shared/projectiles.js` + `ProjectileState` schema:
  `ownerSid / kind / x / z / dir / speed / damage / ttl`.
- Client `ProjectilePool` with per-kind visuals: arrow (cylinder), fireball
  (sphere + `PointLight`), jagged lightning bolt.
- Per-class attack config in `src/shared/classes.js` (archer arrow, mage
  fireball, demon lightning; knight keeps the melee swing).
- Server-authoritative projectile movement + hit resolution; reuse
  `src/shared/combat.js` from Phase 0.

## Phase 2 — Block-while-moving + blood ✅ DONE

Combat feel pass.

- Block no longer roots the player: `blockSpeedMult` ~0.45 while guarding.
- Procedural guard pose (add a `wBlock` weight branch to the sword rig).
- `anim='hit'` for players when they take damage.
- `BloodPool`: red burst + floor splats on unblocked hits.

## Phase 3 — Per-class signature skills + base stats

Replace the shared skill roster with distinct class identities.

- Skill kinds: `bash` (4-unit dash + cone knockback + 1s stun),
  `multishot` (5-arrow fan), `firewave` (3-fireball cone + burn DoT),
  `chainlightning` (4 targets, −20% damage per hop).
- Per-class base stats; drop the global `skillPvpDamage`.
- Unused clips already in the GLBs map to skills by config (no new assets —
  mage `Spell1`/`Spell2`, spike `Weapon`/`HitReact`, archer
  `Gun_Shoot`/`HitRecieve`, everyone's `Death`/`Roll`). Knight is the only
  exception (procedural animation now, Mixamo re-export later —
  `knight_mixamo.glb` only has Attack/Idle/Run).

## Phase 4 — Leveling + upgrade cards

- `src/shared/progression.js`: `xpForLevel`, seeded `rollUpgrades` → 3
  choices, ~16 upgrades (passives + skill-specific).
- PlayerState grows `level / xp / upgrades / pendingChoices`.
- 10s auto-pick timer so PvP never stalls on an unpicked card.

## Phase 5 — Story + PvP arena

- `STORY.md` lore ("Ashfall").
- `ArenaRoom`: duel / team / FFA modes, rounds, optional PvE toggle.
- `LobbyRoom`: queue → redirect matchmaking.

## Phase 6 — Open world

- `src/shared/worldgen.js`: deterministic chunked generation (chunk size 32,
  seeded, 3 biomes: Meadow / Dead Forest / Ashland).
- `WorldRoom`: active-chunk streaming, level-scaled spawns.
- Client: chunk streaming (load radius 2), `InstancedMesh` for perf, minimap.
- CC0 assets from Quaternius / KayKit / Kenney / ambientCG.
- Persistence: JSON per player (`data/players/<name>.json`, debounced 2s) —
  per-player-name files, no accounts (locked decision).

---

## Locked decisions (do not revisit)

- Knight clips = procedural animation now; Mixamo re-export later.
- Persistence = `data/players/<name>.json` per player name, no accounts.
- Character rename: key `spike` → `demon`, label `Demon`, GLB stays
  `spike.glb`, index 3 + localStorage unchanged.

## Load-bearing constraints

- GameRoom.js AND LocalRoom.js mirror all combat logic — every rule change is
  dual-maintenance until Phase 0 extracts the shared core; offline parity is
  a tested contract.
- Unused clips already shipped in GLBs (see Phase 3) — per-skill anims are
  config mapping, not new assets.
- Tests: plain `node:assert` scripts; multiplayer/combat/waves tests boot a
  real Colyseus server in-process on an ephemeral port (pattern:
  `test/multiplayer.test.mjs`).
- All 4 classes currently have identical stats (100 HP, same melee numbers);
  divergence lands in Phase 3.
- `tools/mixamo_to_glb.py` exists (`--extra`/`--trim`) but no source FBX is
  in the repo; Mixamo downloads need the user's login.
