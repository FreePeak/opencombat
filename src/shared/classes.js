// Per-class normal attack config. Index matches CONFIG.characters order:
//   0 knight, 1 archer, 2 mage, 3 demon.
//
// Knight keeps the melee swing; the other three fire projectiles.
// This module is consumed by BOTH the server (spawn logic) and the
// client (VFX / HUD hints) so what you see is what the sim does.
import { SERVER } from '../server/config.js';

/**
 * @typedef {{ kind: 'melee' }} MeleeAttack
 * @typedef {{ kind: 'projectile', projKind: string, speed: number,
 *             damage: number, ttlMs: number, pvpDamage: number }} ProjAttack
 * @typedef {MeleeAttack | ProjAttack} AttackDef
 *
 * Returns the normal-attack definition for `character` (PlayerState.character).
 */
export function attackFor(character) {
  const p = SERVER.projectile;
  switch (character) {
    case 0: return { kind: 'melee' };                                            // knight
    case 1: return { kind: 'projectile', projKind: 'arrow',   speed: p.arrowSpeed,   damage: p.arrowDamage,   ttlMs: p.arrowTtlMs,   pvpDamage: p.rangedPvpDamage }; // archer
    case 2: return { kind: 'projectile', projKind: 'fireball', speed: p.fireballSpeed, damage: p.fireballDamage, ttlMs: p.fireballTtlMs, pvpDamage: p.rangedPvpDamage }; // mage
    case 3: return { kind: 'projectile', projKind: 'lightning', speed: p.lightningSpeed, damage: p.lightningDamage, ttlMs: p.lightningTtlMs, pvpDamage: p.rangedPvpDamage }; // demon
    default: return { kind: 'melee' };                                           // fallback
  }
}
