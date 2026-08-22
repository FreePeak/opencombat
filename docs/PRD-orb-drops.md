# PRD: Kill-Drop XP Orbs

Status: ACTIVE · Loop cycle A · 2026-08-22
Owner: infinite loop session (agent-driven)
Research basis: docs/vampire-survivors-research.md §2 lesson 1 ("reward every
kill physically"), §6 idea #1
Depends on: nothing contested — no schema change, no client render change;
combatBook + both rooms only.

## Problem

Kills grant XP abstractly (`grantXp` at hit-resolution): score ticks up and
nothing exists in the world. VS lesson #1 says every kill should leave a
physical reward — spatial risk/reward (walk into the swarm to collect) and a
dopamine beat per kill. Ashfall already HAS an orb identity (10 roaming orbs:
score +10 / XP +20 on pickup, teleport-respawn) so the loop can be added
without new entity types or client work.

## Solution

**Charged orbs.** When an enemy dies, its kill-XP does NOT land directly:
the nearest UNCHARGED roaming orb teleports to the corpse and becomes
CHARGED with that amount (elites already double via onEliteKill → 60).
Collecting a charged orb pays the normal orb payout PLUS its stored charge,
then it reverts to uncharged and teleport-respawns away. If every orb is
already charged, the XP falls back to the direct path (economy never leaks).

- Solo math is identical in total, just delayed to pickup — the VS feel.
- Co-op turns kill XP into a shared field resource: position near kills to
  bank your team's XP. Deliberate, VS-like.
- Score stays fully direct (leaderboard metric unchanged).
- Daily/waves modes both inherit automatically (shared code paths).

## Scope

1. `src/shared/sim/orbDrops.js` (new pure module, no imports):
   - `chargeForKill(orbs, charges, x, z, amount)` → boolean. Picks the
     nearest uncharged orb by squared distance (index order tiebreak),
     teleports it to (x, z), records `charges.set(orb, amount)`; false when
     every orb is charged (caller falls back to direct grant). Rejects
     re-charging an already-charged orb.
   - `drainCharge(charges, orb)` → number collected (0 if uncharged);
     deletes the entry so the orb reverts.
   - `clearCharges(charges)` → for match reset.
   - Contract header documents the rooms' Map-keyed-by-schema-object idiom
     (same as powerUpTimers) and that positions are caller-owned.
2. combatBook ctx gains optional `dropOrb(corpseX, corpseZ, amount) -> bool`
   (rooms wire it; tests record calls). resolveEnemyHit kill branch and
   onEliteKill route their killer XP through it: `ctx.dropOrb?.(...) !==
   false && ...` — precise rule: try drop; when it returns true SKIP the
   direct grantXp; when false or absent, direct-grant as today. Elite
   doubling composes BEFORE the drop attempt (one 60-charge, not two drops).
3. GameRoom wiring:
   - `this.orbCharges = new Map()` beside powerUpTimers; reset clears it
     wherever streaks reset (playAgain/match reset site).
   - simCombat ctx gets `dropOrb: (x, z, amount) => orbDrops.chargeForKill(
     this.state.orbs, this.orbCharges, x, z, amount)`.
   - updatePickups orb loop: after paying the base payout, drain
     `orbDrops.drainCharge(this.orbCharges, orb)` into
     `grantXp(sid, drained)` (stacks with xpPerOrb); then respawn-teleport
     as today.
4. LocalRoom mirrors 3 exactly (own map + ctx hook + pickup drain) using its
   existing single-player grantXp.
5. Config: no new knobs v1 — amounts reuse `SERVER.progression.xpPerKill`
   (30) and the elite doubling already in onEliteKill.
6. Tests (red-first):
   - Unit `test/orbDrops.test.mjs`: nearest-uncharged selection incl. tie
     stability, teleport-on-charge, all-charged → false without mutation,
     drain reverts + deletes, clearCharges, double-charge rejection.
   - combatBook pins in simCombatBook.test.mjs: kill with dropOrb present →
     grantXp NOT called, dropOrb called with (x, z, xpPerKill); dropOrb
     absent → legacy direct grant unchanged; elite → amount doubled once.
   - Integration extension (waves.test.mjs archetype block pattern): wave-1
     clear leaves ≥1 charged orb whose drain pays 30 XP on collection
     (assert via player.xp delta through a real pickup walk), LocalRoom
     byte-equal charge values.

## Out of scope (v1)

Client visuals for charged orbs (tint/pulse) — the teleport-to-corpse read
is already "the kill popped an orb"; polish later. New drop-only orb pool
beyond the roaming 10. Magnet-attract physics (looter radius upgrade
already applies since pickup logic is untouched). WorldRoom/ArenaRoom
(neither has orbs).

## Acceptance criteria

- AC1: Wave-1 full clear in waves mode leaves at least one orb CHARGED at a
  corpse position; collecting it grants +30 XP beyond the base orb payout.
- AC2: With all orbs charged, further kills direct-grant XP (no loss) —
  unit-pinned fallback.
- AC3: Elite kill charges 60 (doubling preserved, single orb).
- AC4: Non-kill XP paths (daily streak reward, shop picks) NEVER touch the
  drop path (only combatBook routes through ctx.dropOrb).
- AC5: LocalRoom charge values equal GameRoom's wave-for-wave.
- AC6: Full gate green (check + test + smoke) and PROGRESS row recorded.
