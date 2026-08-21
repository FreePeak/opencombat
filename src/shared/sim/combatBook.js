// D5 enemy-hit resolution + D4 burn DoT — shared by BOTH game sims (GameRoom
// + LocalRoom). Extracted from two mirrored room implementations (P1.3 Slice
// 2, see docs/plans/p1.3-shared-sim-extraction.md); the shared strike math
// itself lives in ../combat.js, this module only wires the room-level flow.
//
// Every function takes a ctx built ONCE per room:
//   state:          WorldState (only .wave is read, for kill logging)
//   half:           arena half-extent for knockback clamping
//   players:        Map-like sid -> PlayerState (room-owned schema)
//   enemyAnimUntil: Map enemy -> ms of 'hit'/'attack' anim override expiry
//   enemyStunUntil: Map enemy -> ms of HIT-STUN expiry
//   burnByProjId:   Map projectile id -> firewave burn def {damage,
//                   durationMs, tickMs} — registered at spawn, consumed on hit
//   activeBurns:    Map enemy -> live burn state {damage, remainingMs,
//                   tickMs, lastTickMs}
//   now():          injected clock — never defaulted, Date.now and
//                 performance.now must not mix inside one ctx
//   grantXp(sid, amount): progression hook (rooms wire it to
//                 leveling.grantXp; tests record calls)
//   log(event, fields): observability hook; LocalRoom passes none so its
//                 observable behavior stays unchanged.
//
// resolveEnemyHit is SID-BASED: callers pass the killer's session id directly,
// which deletes GameRoom's reverse object lookup AND LocalRoom's identity
// compare in one stroke. Schema objects are consumed duck-typed; construction
// of PlayerState/EnemyState/ProjectileState instances stays in the rooms. No
// three / colyseus imports here — pinned by test/simCombatBook.test.mjs.

import { SERVER } from '../../server/config.js';
import { strikeEnemy } from '../combat.js';

/**
 * Apply one hit of `damage` to a LIVING enemy from (srcX, srcZ): knockback +
 * HP drop via strikeEnemy; on kill the killer (resolved from `killerSid`)
 * scores `SERVER.enemy.killScore`, XP flows through ctx.grantXp and the kill
 * is logged; survivors get anim='hit' + an anim override window + a
 * HIT-STUN window on the injected clock.
 *
 * @param {object} ctx - room context (see module header)
 * @param {object} enemy - EnemyState instance owned by the room
 * @param {number} damage
 * @param {number} srcX - hit source x (knockback direction origin)
 * @param {number} srcZ
 * @param {string|null} killerSid - session id of the killer, null if none
 * @param {number} [stunOverrideMs] - replaces SERVER.enemy.hitStunMs for the
 *   stun window (reserved for D9 bash-style stuns; unused by rooms today)
 * @returns {{hit: boolean, killed: boolean}}
 */
export function resolveEnemyHit(ctx, enemy, damage, srcX, srcZ, killerSid = null, stunOverrideMs) {
  const { hit, killed } = strikeEnemy(
    enemy, damage, srcX, srcZ, SERVER.enemy.hitKnockback, ctx.half);
  if (!hit) return { hit: false, killed: false };
  if (killed) {
    const killer = killerSid != null ? ctx.players.get(killerSid) : undefined;
    if (killer) {
      killer.score += SERVER.enemy.killScore;
      ctx.grantXp?.(killerSid, SERVER.progression?.xpPerKill ?? 30);
    }
    ctx.log?.('enemy_killed', { wave: ctx.state.wave, by: killer?.name });
    return { hit, killed };
  }
  // Survived the hit: stagger — no chase, no contact damage until the stun
  // expires (this is what makes hits read as impactful).
  const now = ctx.now();
  enemy.anim = 'hit';
  ctx.enemyAnimUntil.set(enemy, now + SERVER.enemy.hitAnimMs);
  ctx.enemyStunUntil.set(enemy, now + (stunOverrideMs ?? SERVER.enemy.hitStunMs));
  return { hit, killed };
}

/** Record a firewave projectile's burn payload keyed by proj.id (D4). */
export function registerProjBurn(ctx, projId, burnDef) {
  ctx.burnByProjId.set(projId, burnDef);
}

/**
 * On a fireball hitting `enemy`: promote the burn def registered for
 * proj.id into an activeBurns entry keyed by the ENEMY, anchored to the
 * injected clock. Consumes the registration so one projectile burns once.
 * @returns true when a burn was started.
 */
export function startBurnFromProjectile(ctx, proj, enemy) {
  const burn = ctx.burnByProjId.get(proj.id);
  if (!burn) return false;
  ctx.burnByProjId.delete(proj.id);
  ctx.activeBurns.set(enemy, {
    damage: burn.damage,
    remainingMs: burn.durationMs,
    tickMs: burn.tickMs,
    lastTickMs: ctx.now(),
  });
  return true;
}

/**
 * Tick all active burns once per sim step: dead enemies drop immediately;
 * after >= tickMs since the anchor, damage lands (clamped at 0 hp), the
 * anchor resets to now and remainingMs decays by the WHOLE elapsed gap;
 * exhausted entries drop. Iterating the Map directly is safe because deletes
 * during iteration are well-defined for JS Maps.
 * @param {object} ctx
 * @param {number} now - current clock reading from the SAME clock ctx.now()
 *   was built with (rooms pass Date.now() / performance.now() respectively).
 */
export function tickBurns(ctx, now) {
  for (const [enemy, burn] of ctx.activeBurns) {
    if (enemy.hp <= 0) { ctx.activeBurns.delete(enemy); continue; }
    const elapsed = now - burn.lastTickMs;
    if (elapsed >= burn.tickMs) {
      enemy.hp = Math.max(0, enemy.hp - burn.damage);
      burn.lastTickMs = now;
      burn.remainingMs -= elapsed;
    }
    if (burn.remainingMs <= 0) ctx.activeBurns.delete(enemy);
  }
}
