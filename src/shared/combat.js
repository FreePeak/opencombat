// Shared combat math used by BOTH game sims — the authoritative server room
// (GameRoom) and the offline browser room (LocalRoom). Every rule both must
// honor lives here so a combat change is edited once, not twice; the rooms
// keep the bookkeeping this module must not know about (anim/stun timers,
// invulnerability windows, kill score, log events).
//
// All functions are pure (aside from mutating the hit target's position/HP):
// same inputs -> same outcomes on the server and in the browser, which is the
// offline-parity contract the test suite pins down.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Facing unit vector from a yaw angle (atan2 convention: +Z is 0, +X is 90°).
 * The server and the client both turn rotY into (fx, fz) this way.
 */
export function facingVector(rotY) {
  return { fx: Math.sin(rotY), fz: Math.cos(rotY) };
}

/**
 * Arc test: is the offset (dx, dz) from the attacker inside a cone of `range`
 * reach and cos(angle to facing) >= arcCos? (arcCos 0.5 = 60° cone.) Distance
 * 0 never hits (dot 0 vs arcCos > 0), same as the old `dist || 1` guard.
 */
export function inArc(fx, fz, range, arcCos, dx, dz) {
  const dist = Math.hypot(dx, dz);
  return dist <= range && (dx * fx + dz * fz) / (dist || 1) >= arcCos;
}

/**
 * Which of `targets` a melee swing from `attacker` strikes. Returns indices
 * into `targets` (each {x, z, hp}) — dead targets (hp a number and <= 0) are
 * skipped, mirroring both rooms' `if (hp <= 0) continue`.
 */
export function meleeHits(attacker, targets, cfg) {
  const { fx, fz } = facingVector(attacker.rotY);
  const hits = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (typeof t.hp === 'number' && t.hp <= 0) continue;
    if (inArc(fx, fz, cfg.attackRange, cfg.attackArcCos, t.x - attacker.x, t.z - attacker.z)) hits.push(i);
  }
  return hits;
}

/**
 * True when `player` is guarding (L held) AND the hit source at (ax, az) lies
 * inside its frontal arc — a successful block negates the hit entirely.
 */
export function blockedHit(player, ax, az, blockArcCos) {
  if (!player.blocking) return false;
  const dx = ax - player.x;
  const dz = az - player.z;
  const dist = Math.hypot(dx, dz) || 1;
  const dot = (dx * Math.sin(player.rotY) + dz * Math.cos(player.rotY)) / dist;
  return dot >= blockArcCos;
}

/**
 * Apply one hit of `damage` to an enemy: HP drop + knockback away from
 * (srcX, srcZ), clamped inside the arena half-extent. The room decides the
 * side effects (hit anim + stun on survivors, kill score on kills).
 * @returns {{hit: boolean, killed: boolean}} — hit false = dead/immune input.
 */
export function strikeEnemy(enemy, damage, srcX, srcZ, knockback, half) {
  if (enemy.hp <= 0) return { hit: false, killed: false }; // dead stays dead
  enemy.hp -= damage;
  const dx = enemy.x - srcX;
  const dz = enemy.z - srcZ;
  const dist = Math.hypot(dx, dz) || 1;
  enemy.x = clamp(enemy.x + dx / dist * knockback, -half, half);
  enemy.z = clamp(enemy.z + dz / dist * knockback, -half, half);
  if (enemy.hp <= 0) {
    enemy.hp = 0;
    return { hit: true, killed: true };
  }
  return { hit: true, killed: false };
}

/**
 * Apply one hit of `amount` to a player: HP drop + knockback away from the
 * source, clamped inside the arena. (LocalRoom passes knockback 0 — the
 * offline sim has never shoved the player around; the server passes its
 * damage nudge. Same code path, one rule.)
 * @returns {boolean} true when the player's HP reached 0.
 */
export function strikePlayer(player, amount, srcX, srcZ, knockback, half) {
  player.hp = Math.max(0, player.hp - amount);
  const dx = player.x - srcX;
  const dz = player.z - srcZ;
  const dist = Math.hypot(dx, dz) || 1;
  player.x = clamp(player.x + dx / dist * knockback, -half, half);
  player.z = clamp(player.z + dz / dist * knockback, -half, half);
  return player.hp <= 0;
}
