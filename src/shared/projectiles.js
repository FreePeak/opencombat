// Pure projectile math shared by the server (GameRoom) and the offline sim
// (LocalRoom). Every function is pure — no side effects, same inputs → same
// outputs on both sides. The rooms keep the bookkeeping (spawning, removing,
// anim timers); this module only does movement, collision and TTL.
//
// Reuses combat.js for the actual damage application (strikeEnemy, strikePlayer,
// blockedHit) so the projectile damage path is identical to melee.

import { strikeEnemy, strikePlayer, blockedHit } from './combat.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Step a projectile forward by dt seconds. Returns the new {x, z} position
 * and the remaining ttl (milliseconds). The projectile is a simple linear
 * mover — no gravity, no homing.
 * @param {{ x: number, z: number, dirX: number, dirZ: number, speed: number, ttl: number }}
 *        proj — current projectile state (mutated in place).
 * @param {number} dt — timestep in seconds.
 * @returns {{ x: number, z: number, ttl: number }} new position + remaining ttl.
 */
export function stepProjectile(proj, dt) {
  proj.x += proj.dirX * proj.speed * dt;
  proj.z += proj.dirZ * proj.speed * dt;
  proj.ttl -= dt * 1000;
  return { x: proj.x, z: proj.z, ttl: proj.ttl };
}

/**
 * True when the projectile has left the arena or its TTL expired.
 */
export function projectileExpired(proj, half) {
  return proj.ttl <= 0 ||
    proj.x < -half || proj.x > half ||
    proj.z < -half || proj.z > half;
}

/**
 * Check collision between a projectile and a circular target.
 * @param {{ x: number, z: number }} projPos — projectile position.
 * @param {{ x: number, z: number }} target — target position.
 * @param {number} hitRadius — collision distance threshold.
 * @returns {boolean}
 */
export function projectileHitsTarget(projPos, target, hitRadius) {
  const dx = target.x - projPos.x;
  const dz = target.z - projPos.z;
  return (dx * dx + dz * dz) <= hitRadius * hitRadius;
}

/**
 * Resolve a projectile hit against a single enemy. Uses the shared strikeEnemy
 * from combat.js for HP drop + knockback.
 * @returns {{ hit: boolean, killed: boolean }}
 */
export function resolveProjectileEnemyHit(enemy, damage, srcX, srcZ, knockback, half) {
  return strikeEnemy(enemy, damage, srcX, srcZ, knockback, half);
}

/**
 * Resolve a projectile hit against a player. Uses the shared blockedHit and
 * strikePlayer from combat.js for block check + HP drop + knockback.
 * @returns {{ blocked: boolean, killed: boolean }}
 */
export function resolveProjectilePlayerHit(player, damage, srcX, srcZ, knockback, half, blockArcCos) {
  if (blockedHit(player, srcX, srcZ, blockArcCos)) {
    return { blocked: true, killed: false };
  }
  const killed = strikePlayer(player, damage, srcX, srcZ, knockback, half);
  return { blocked: false, killed };
}
