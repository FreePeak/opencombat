// D6 room-level projectile step/collide/remove loop — shared by BOTH game sims
// (GameRoom + LocalRoom). Extracted from two mirrored room implementations
// (P1.3 Slice 3, see docs/plans/p1.3-shared-sim-extraction.md section 1 D6);
// the pure movement/collision math lives in ../projectiles.js, this module only
// wires the room-level loop over the live schema collections.
//
// Every function takes a ctx built ONCE per room:
//   state:          WorldState (only .projectiles/.enemies/.players are read)
//   half:           arena half-extent for TTL/bounds expiry
//   burnByProjId:   Map projectile id -> firewave burn def (D4 register; the
//                 loop hands fireball hits to combatBook.startBurnFromProjectile
//                 through it — omit both burn fields to skip the handoff)
//   activeBurns:    Map enemy -> live burn state (D4 sink for the handoff)
//   now():          injected clock anchoring new burns — never defaulted,
//                 Date.now and performance.now must not mix inside one ctx
//   onHitEnemy(proj, enemy):  room hook resolving damage/kill/stun (rooms wire
//                 it to combatBook.resolveEnemyHit via their hit methods;
//                 tests record calls). Called at most once per projectile.
//   onHitPlayer(proj, sid, victim): room hook applying player damage. Called
//                 at most once per projectile.
//
// Player-branch rule unified onto GameRoom's: OWNER projectiles can hit OTHER
// living players only (sid filter + hp guard). LocalRoom's old inverted branch
// (`!proj.ownerIsPlayer` hitting the local player) was unreachable dead code —
// nothing spawns a non-owner-owned projectile in either sim — and is pinned by
// test/simProjectileLoop.test.mjs so it cannot silently flip back.
//
// Schema objects are consumed duck-typed (ArraySchema splice during a reverse
// index walk, MapSchema entries); construction of ProjectileState instances
// stays in the rooms. No three / colyseus imports here — pinned by
// test/simProjectileLoop.test.mjs.

import { SERVER } from '../../server/config.js';
import { stepProjectile, projectileExpired, projectileHitsTarget } from '../projectiles.js';
import { startBurnFromProjectile } from './combatBook.js';

/**
 * Step every live projectile once: move by `dt`, splice out TTL/bounds-expired
 * ones, collide owner projectiles with living enemies (onHitEnemy + D4 burn
 * handoff) then with other living players (onHitPlayer). Removal happens on
 * hit or expiry; surviving projectiles stay pooled in state.projectiles.
 *
 * @param {object} ctx - room context (see module header)
 * @param {number} dt - fixed timestep in SECONDS (same unit the rooms tick
 *   updateProjectiles/_updateProjectiles with today).
 */
export function stepProjectiles(ctx, dt) {
  const state = ctx.state;
  const hitRadius = SERVER.projectile.hitRadius;
  for (let i = state.projectiles.length - 1; i >= 0; i--) {
    const proj = state.projectiles[i];
    stepProjectile(proj, dt);

    // Expired (TTL or out of arena)?
    if (projectileExpired(proj, ctx.half)) {
      state.projectiles.splice(i, 1);
      continue;
    }

    let removed = false;

    // Hit enemies?
    if (proj.ownerIsPlayer) {
      for (const enemy of state.enemies) {
        if (enemy.hp <= 0) continue;
        if (projectileHitsTarget(proj, enemy, hitRadius)) {
          ctx.onHitEnemy?.(proj, enemy);
          // Firewave burn DoT: apply burn when a fireball hits (D4 handoff;
          // a no-op unless a def was registered under proj.id at spawn time).
          if (ctx.burnByProjId && ctx.activeBurns) {
            startBurnFromProjectile(ctx, proj, enemy);
          }
          state.projectiles.splice(i, 1);
          removed = true;
          break;
        }
      }
    }

    // PvP: hit other living players? (owner excluded by sid, corpses skipped)
    if (!removed && proj.ownerIsPlayer) {
      for (const [osid, victim] of state.players) {
        if (osid === proj.ownerSid || victim.hp <= 0) continue;
        if (projectileHitsTarget(proj, victim, hitRadius)) {
          ctx.onHitPlayer?.(proj, osid, victim);
          state.projectiles.splice(i, 1);
          removed = true;
          break;
        }
      }
    }
  }
}
