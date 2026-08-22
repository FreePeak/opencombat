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
// ELITE AFFIX HOOKS (PRD-elite-affixes.md, Step B):
//   volatilePending: Map enemy -> {at, damage, radius} — armed by onEliteKill
//                 when a Volatile elite dies; tickVolatile drains entries due
//                 on ctx.now() each sim step (rooms own the map + clock).
//   eliteMaxHp(enemy): max-HP lookup for the vampiric heal clamp — EnemyState
//                 has no maxHp field, so rooms recompute ceil(waveEnemyHp *
//                 hpMul); absent, the heal clamps to the current HP (no-op).
//   damagePlayer(sid, victim, amount, srcX, srcZ): the room's own player-
//                 damage path; tickVolatile routes its AoE through it so
//                 block/shield/invulnerability rules stay authoritative.
//
// resolveEnemyHit is SID-BASED: callers pass the killer's session id directly,
// which deletes GameRoom's reverse object lookup AND LocalRoom's identity
// compare in one stroke. Schema objects are consumed duck-typed; construction
// of PlayerState/EnemyState/ProjectileState instances stays in the rooms. No
// three / colyseus imports here — pinned by test/simCombatBook.test.mjs.

import { SERVER } from '../../server/config.js';
import { strikeEnemy } from '../combat.js';
import { affixByName } from './elites.js';
import { archetypeByName } from './archetypes.js';
import * as orbDrops from './orbDrops.js';

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
    enemy, damage, srcX, srcZ, knockbackAgainst(enemy, SERVER.enemy.hitKnockback), ctx.half);
  if (!hit) return { hit: false, killed: false };
  if (killed) {
    const killer = killerSid != null ? ctx.players.get(killerSid) : undefined;
    if (killer) {
      killer.score += SERVER.enemy.killScore;
      payKillXp(ctx, enemy, killerSid); // charge-or-grant; elite doubles inside
    }
    ctx.log?.('enemy_killed', { wave: ctx.state.wave, by: killer?.name });
    onEliteKill(ctx, enemy, killerSid);
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

// ---------------------------------------------------------------------------
// Elite affix hooks (PRD-elite-affixes.md, Step B) — shared by BOTH rooms so
// online and offline stay behaviorally identical by construction.
// ---------------------------------------------------------------------------

/**
 * Knockback magnitude to apply when striking `enemy`: knockback-immune elites
 * (Bulwark) take the HP drop but are never shoved; otherwise the base is
 * scaled by the enemy's archetype (Tank x0.25, PRD-enemy-archetypes.md).
 * Callers wrap their base knockback with this at every enemy-strike site
 * (resolveEnemyHit here, plus each room's bash cone). Non-elite, non-archetype
 * math is untouched.
 * @returns {number} 0 for immune elites, else `baseKnockback` (x archetype mul).
 */
export function knockbackAgainst(enemy, baseKnockback) {
  if (!(baseKnockback > 0)) return baseKnockback;
  if (enemy?.elite && affixByName(enemy.elite)?.knockbackImmune) {
    return 0;
  }
  const arch = enemy?.archetype ? archetypeByName(enemy.archetype) : null;
  return arch ? baseKnockback * arch.knockbackMul : baseKnockback;
}

/**
 * Single source of kill-XP payment (PRD-orb-drops.md). Elites double the
 * value BEFORE the drop attempt so an elite charges ONE orb with 2x. When
 * the room wires ctx.dropOrb and it succeeds, XP rides a charged orb at the
 * corpse; on failure/absence the legacy direct grant fires — the economy
 * never leaks. Callers must have already added score themselves.
 */
export function payKillXp(ctx, enemy, killerSid) {
  if (killerSid == null) return;
  const base = SERVER.progression?.xpPerKill ?? 30;
  const affix = enemy?.elite ? affixByName(enemy.elite) : null;
  const value = affix ? base * 2 : base;
  if (ctx.dropOrb?.(enemy.x, enemy.z, value)) return;
  ctx.grantXp?.(killerSid, value);
}

/**
 * Elite kill extras, called from EVERY kill path (resolveEnemyHit here plus
 * each room's direct bash strike): a reward burst of DOUBLE killScore + XP
 * through the same score/grantXp paths, and — for Volatile elites — arming a
 * delayed AoE explosion in ctx.volatilePending keyed by the corpse. The fuse
 * fires fuseMs later on the injected clock; tickVolatile applies it.
 * No-op for non-elite enemies (guard: only when dead enemy .elite !== '').
 */
export function onEliteKill(ctx, enemy, killerSid = null) {
  if (!enemy || !enemy.elite) return;
  const affix = affixByName(enemy.elite);
  if (!affix) return;
  const killer = killerSid != null ? ctx.players.get(killerSid) : undefined;
  if (killer) {
    killer.score += SERVER.enemy.killScore; // double score
    // XP doubling lives in payKillXp (charge-or-grant with value x2) —
    // PRD-orb-drops.md routes ALL kill XP through one site.
  }
  ctx.log?.('elite_killed', { wave: ctx.state.wave, affix: affix.name, by: killer?.name });
  if (affix.volatile && ctx.volatilePending && !ctx.volatilePending.has(enemy)) {
    ctx.volatilePending.set(enemy, {
      at: ctx.now() + affix.volatile.fuseMs,
      damage: affix.volatile.damage,
      radius: affix.volatile.radius,
    });
  }
}

/**
 * Vampiric elite hook: called after an ELITE damages a player through the
 * shared resolution path. Heals the attacker by vampiricPct * actualDamage,
 * clamped to its maxHp via the ctx.eliteMaxHp(enemy) lookup (rooms recompute
 * ceil(waveEnemyHp * hpMul) because EnemyState carries no maxHp field).
 * @returns {number} the HP actually restored (0 when not applicable).
 */
export function applyVampiricHeal(ctx, attacker, damageDealt) {
  if (!attacker || !attacker.elite || !(damageDealt > 0)) return 0;
  const affix = affixByName(attacker.elite);
  const maxHp = Number(ctx.eliteMaxHp?.(attacker)) || attacker.hp;
  if (!affix || !(affix.vampiricPct > 0) || attacker.hp >= maxHp) return 0;
  const healed = Math.min(maxHp - attacker.hp, affix.vampiricPct * damageDealt);
  attacker.hp += healed;
  return healed;
}

/**
 * Tick all pending Volatile fuses once per sim step (`now` from the SAME
 * clock the rooms armed entries with). A due entry explodes ONCE: every LIVING
 * player within radius takes damage through ctx.damagePlayer (the room's own
 * path — block/shield/invulnerability still apply), THEN the entry is dropped
 * so the corpse is released. Iterating while deleting is safe for JS Maps.
 */
export function tickVolatile(ctx, now) {
  if (!ctx.volatilePending?.size) return;
  for (const [enemy, boom] of ctx.volatilePending) {
    if (now < boom.at) continue;
    ctx.volatilePending.delete(enemy);
    for (const [sid, player] of ctx.players) {
      if (player.hp <= 0) continue; // corpses cannot be hurt
      if (Math.hypot(player.x - enemy.x, player.z - enemy.z) <= boom.radius) {
        ctx.damagePlayer?.(sid, player, boom.damage, enemy.x, enemy.z);
      }
    }
    ctx.log?.('volatile_explode', { wave: ctx.state.wave, x: enemy.x, z: enemy.z });
  }
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
