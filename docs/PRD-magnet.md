# PRD: Magnet Power-Up

Status: ACTIVE · Loop cycle C · 2026-08-22
Owner: infinite loop session (agent-driven)
Research basis: docs/vampire-survivors-research.md §2 lesson 9, §6 idea #6
Depends on: nothing contested — server-dominant diff (config + pickup loops +
one pure module). Client gets a color + tiny mesh branch only.

## Problem

The power-up trio (speed/shield/double) predates the kill-drop orb economy.
VS lesson #9 wants risk/reward pickups that create stories; the single best
synergy with charged-orb drops is positional: let a pickup PULL the field
toward you. Also fixes a real friction: wave-clear gem bursts spawn at
corpses the player must trudge between during an 8s breather.

## Solution

Fourth power-up type `magnet`: on pickup, for `durationMs` every roaming orb
within `pullRadius` (charged or not) drifts toward the holder at `pullSpeed`,
clamped against overshoot. Collection math untouched — pulled orbs simply
enter pickup radius and pay normally (base payout + stored charge if any).
Multiple holders: first-in-insertion-order wins per orb per tick (same
one-per-orb rule as collection). Deterministic in both sims by construction.

## Scope

1. `src/shared/sim/magnetPull.js` (new pure module): `pullOrbs(orbs,
   holders, radius, speed, dt)` — moves each orb toward the FIRST holder
   within radius by min(speed*dt, dist); returns moved count. No imports.
2. Config: `powerUps.magnet = { durationMs: 8000, pullRadius: 8,
   pullSpeed: 10 }`; `count` 3→4 so all four types spawn (spawn list gains
   'magnet').
3. GameRoom.updatePickups: build magnetHolders (living, effects has
   'magnet'); before the orb proximity loop, pullOrbs(...) with dt already
   passed in. LocalRoom mirrors identically.
4. Client: `CONFIG.powerUps.colors.magnet` (violet) + horseshoe-torus mesh
   branch in addPowerUp (~8 lines). Effects expiry is generic — no timer work.
5. Tests red-first `test/magnetPull.test.mjs`: within-radius pull with
   clamp, beyond-radius ignore, holder insertion-order rule, empty holders
   no-op, moved-count return. Integration block in waves.test.mjs
   (direct-drive): effects.set('magnet') → orb 5u away converges and pays
   through normal pickup within budget; LocalRoom parity via same drive.

## Out of scope

Magnet as passive upgrade stacking with looter (looter still multiplies
COLLECT radius independently — they compose naturally). Pull affecting
power-ups/enemies/projectiles. Client trail VFX.

## Acceptance criteria

- AC1: With magnet active, an orb 5u away reaches the holder and pays base
  (+charge if any) within durationMs in BOTH sims.
- AC2: Orbs beyond pullRadius never move; pull never overshoots the holder.
- AC3: Two holders: orb drifts toward the earlier-inserted holder when both
  in range.
- AC4: Magnet expiry stops pulls (generic effects tick covers this).
- AC5: All four types spawn (count 4) — spawn list test-pinned.
- AC6: Full gate green (check/test/smoke) + PROGRESS row.
