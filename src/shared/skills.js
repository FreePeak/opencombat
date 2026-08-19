// Per-character skill definitions + hit resolution, shared by the server
// (authoritative damage) and the client (HUD + VFX) so the two sides can
// never drift. Indexed by PlayerState.character (== CONFIG.characters order:
// 0 knight, 1 archer, 2 mage, 3 demon).
//
// Phase 3 adds four distinct skill kinds replacing the old aoe/cone pair:
//   bash        — knight: 4-unit dash + cone knockback + 1s stun
//   multishot   — archer: 5-arrow fan (projectile-spawning)
//   firewave    — mage:   3-fireball cone + burn DoT (projectile-spawning)
//   chainlight  — demon:  4 targets, −20% damage per hop (instant)
//
// Every character shares the normal melee/ranged (J). The skill (K) is the
// distinct per-character cast. `kind` selects the resolution path.

// ---------------------------------------------------------------------------
// Bash constants
// ---------------------------------------------------------------------------
export const BASH_RANGE        = 4;      // dash distance in units
export const BASH_ARC_COS      = 0.5;    // cos(60°) — cone at landing
export const BASH_KNOCKBACK    = 3;      // units pushed away from caster
export const STUN_DURATION_MS  = 1000;   // 1-second stun on hit enemies

// Multishot constants
export const MULTISHOT_COUNT   = 5;      // arrows per cast
export const MULTISHOT_FAN_DEG = 30;     // total fan spread in degrees

// Firewave constants
export const FIREWAVE_COUNT    = 3;      // fireballs per cast
export const BURN_TICK_DAMAGE  = 1;      // damage per burn tick
export const BURN_DURATION_MS  = 3000;   // total burn duration
export const BURN_TICK_MS      = 1000;   // interval between burn ticks

// Chain lightning constants
export const CHAIN_MAX_TARGETS   = 4;
export const CHAIN_DAMAGE_DECAY  = 0.2;  // −20% damage per hop

// ---------------------------------------------------------------------------
// Skill definitions
// ---------------------------------------------------------------------------
export const SKILLS = [
  {
    key: 'bash', name: 'Shield Bash', kind: 'bash',
    damage: 2, cooldownMs: 2500, animMs: 400, color: 0xffd54f,
    dashDistance: BASH_RANGE,
    stunDurationMs: STUN_DURATION_MS,
    knockback: BASH_KNOCKBACK,
  },
  {
    key: 'multishot', name: 'Multishot', kind: 'multishot',
    damage: 1, cooldownMs: 3000, animMs: 450, color: 0x00e5ff,
    arrowCount: MULTISHOT_COUNT,
    fanDegrees: MULTISHOT_FAN_DEG,
  },
  {
    key: 'firewave', name: 'Firewave', kind: 'firewave',
    damage: 1, cooldownMs: 3500, animMs: 500, color: 0xff6e40,
    fireballCount: FIREWAVE_COUNT,
    burnDamage: BURN_TICK_DAMAGE,
    burnDurationMs: BURN_DURATION_MS,
    burnTickMs: BURN_TICK_MS,
  },
  {
    key: 'chainlight', name: 'Chain Lightning', kind: 'chainlight',
    damage: 2, cooldownMs: 3000, animMs: 450, color: 0xce93d8,
    maxTargets: CHAIN_MAX_TARGETS,
    damageDecay: CHAIN_DAMAGE_DECAY,
  },
];

/** Fallback so an out-of-range character index still casts something sane. */
export function skillFor(character) {
  return SKILLS[character] || SKILLS[0];
}

// ---------------------------------------------------------------------------
// Per-class base stats (Phase 3). Replaces the identical 100-HP global pool.
// Index matches CONFIG.characters: 0 knight, 1 archer, 2 mage, 3 demon.
// ---------------------------------------------------------------------------
export const CLASS_STATS = [
  { // Knight — tanky melee bruiser
    hp: 150,
    speed: 8,
    meleeDamage: 2,
    meleePvpDamage: 15,
    skillPvpDamage: 15,
  },
  { // Archer — fast ranged
    hp: 80,
    speed: 11,
    rangedDamage: 1,
    rangedPvpDamage: 10,
    skillPvpDamage: 8,
  },
  { // Mage — AoE caster
    hp: 90,
    speed: 9,
    skillDamage: 2,
    skillPvpDamage: 10,
  },
  { // Demon — chain caster
    hp: 80,
    speed: 10,
    skillDamage: 2,
    skillPvpDamage: 12,
  },
];

/**
 * Return the base stats for a character index.
 * @param {number} character
 */
export function classStats(character) {
  return CLASS_STATS[character] || CLASS_STATS[0];
}

// ---------------------------------------------------------------------------
// Bash helper: compute caster displacement from facing direction.
// The room moves the caster; skill resolution uses the NEW position.
// ---------------------------------------------------------------------------
export function resolveBash(caster) {
  const fx = Math.sin(caster.rotY);
  const fz = Math.cos(caster.rotY);
  const dashDist = BASH_RANGE;
  return {
    newX: caster.x + fx * dashDist,
    newZ: caster.z + fz * dashDist,
  };
}

// ---------------------------------------------------------------------------
// Multishot helper: compute 5 arrow directions in a fan around facing.
// Returns array of { dirX, dirZ } unit vectors.
// ---------------------------------------------------------------------------
export function resolveMultishot(caster, skill) {
  const fx = Math.sin(caster.rotY);
  const fz = Math.cos(caster.rotY);
  const count = skill.arrowCount || MULTISHOT_COUNT;
  const fanDeg = skill.fanDegrees || MULTISHOT_FAN_DEG;
  const fanRad = (fanDeg * Math.PI) / 180;
  const baseAngle = Math.atan2(fx, fz); // facing angle
  const arrows = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : (i / (count - 1)) - 0.5; // −0.5 to +0.5
    const angle = baseAngle + t * fanRad;
    arrows.push({
      dirX: Math.sin(angle),
      dirZ: Math.cos(angle),
    });
  }
  return arrows;
}

// ---------------------------------------------------------------------------
// Firewave helper: compute 3 fireball directions in a cone around facing.
// Returns array of { dirX, dirZ } unit vectors.
// ---------------------------------------------------------------------------
export function resolveFirewave(caster, skill) {
  const fx = Math.sin(caster.rotY);
  const fz = Math.cos(caster.rotY);
  const count = skill.fireballCount || FIREWAVE_COUNT;
  // Firewave cone is narrower than multishot fan: 20° total
  const fanDeg = 20;
  const fanRad = (fanDeg * Math.PI) / 180;
  const baseAngle = Math.atan2(fx, fz);
  const balls = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : (i / (count - 1)) - 0.5;
    const angle = baseAngle + t * fanRad;
    balls.push({
      dirX: Math.sin(angle),
      dirZ: Math.cos(angle),
    });
  }
  return balls;
}

// ---------------------------------------------------------------------------
// Chain lightning helper: pick up to N closest living targets, compute
// decaying damage per hop.
// ---------------------------------------------------------------------------
export function resolveChainTargets(caster, enemies, baseDamage, maxTargets) {
  const candidates = [];
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (typeof e.hp === 'number' && e.hp <= 0) continue;
    const dist = Math.hypot(e.x - caster.x, e.z - caster.z);
    candidates.push({ idx: i, dist });
  }
  // Sort by distance (closest first)
  candidates.sort((a, b) => a.dist - b.dist);
  const capped = candidates.slice(0, maxTargets);
  const decay = CHAIN_DAMAGE_DECAY;
  return capped.map((c, hop) => ({
    idx: c.idx,
    damage: +(baseDamage * Math.pow(1 - decay, hop)).toFixed(4),
  }));
}

// ---------------------------------------------------------------------------
// Pure hit resolution: returns { hits, projectiles?, movement?, damagePerHit? }
// that the room applies. The room handles bash displacement, projectile
// spawning, and burn DoT tracking.
//
//   bash        — instant hit at the LANDING position (after dash)
//   multishot   — returns projectile definitions (arrow fan)
//   firewave    — returns projectile definitions (fireball cone) + burn metadata
//   chainlight  — instant hits on up to N closest targets with decayed damage
// ---------------------------------------------------------------------------
export function resolveSkillHits(skill, caster, enemies) {
  if (skill.kind === 'bash') {
    return _resolveBash(skill, caster, enemies);
  }
  if (skill.kind === 'multishot') {
    return _resolveMultishot(skill, caster, enemies);
  }
  if (skill.kind === 'firewave') {
    return _resolveFirewave(skill, caster, enemies);
  }
  if (skill.kind === 'chainlight') {
    return _resolveChainlight(skill, caster, enemies);
  }
  // Legacy aoe/cone (Phase 2 backward compat — should not be reached now)
  return _resolveLegacy(skill, caster, enemies);
}

// --- bash: dash + cone at landing ---
function _resolveBash(skill, caster, enemies) {
  const { newX, newZ } = resolveBash(caster);
  const fx = Math.sin(caster.rotY);
  const fz = Math.cos(caster.rotY);
  const hits = [];
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (typeof e.hp === 'number' && e.hp <= 0) continue;
    const dx = e.x - newX;
    const dz = e.z - newZ;
    const dist = Math.hypot(dx, dz);
    if (dist <= BASH_RANGE && dist > 1e-6) {
      const dot = (dx * fx + dz * fz) / dist;
      if (dot >= BASH_ARC_COS) hits.push(i);
    }
  }
  return {
    hits,
    movement: { dx: newX - caster.x, dz: newZ - caster.z },
  };
}

// --- multishot: 5-arrow fan projectiles ---
function _resolveMultishot(skill, caster, enemies) {
  const arrows = resolveMultishot(caster, skill);
  const projectiles = arrows.map((a) => ({
    dirX: a.dirX,
    dirZ: a.dirZ,
    projKind: 'arrow',
    damage: skill.damage,
    speed: 18,    // arrow speed (matches config.projectile.arrowSpeed)
    ttlMs: 1500,  // arrow TTL
  }));
  return { hits: [], projectiles };
}

// --- firewave: 3-fireball cone + burn metadata ---
// Damage comes ONLY from the fireballs on contact (+ burn) — no direct cone
// hits, which double-damaged anything close to the caster.
function _resolveFirewave(skill, caster, enemies) {
  const balls = resolveFirewave(caster, skill);
  const projectiles = balls.map((b) => ({
    dirX: b.dirX,
    dirZ: b.dirZ,
    projKind: 'fireball',
    damage: skill.damage,
    speed: 14,   // fireball speed
    ttlMs: 2000,
    effects: {
      burn: {
        damage: skill.burnDamage || BURN_TICK_DAMAGE,
        durationMs: skill.burnDurationMs || BURN_DURATION_MS,
        tickMs: skill.burnTickMs || BURN_TICK_MS,
      },
    },
  }));
  return { hits: [], projectiles };
}

// --- chainlight: up to 4 targets, −20% per hop ---
function _resolveChainlight(skill, caster, enemies) {
  const maxTargets = skill.maxTargets || CHAIN_MAX_TARGETS;
  const baseDamage = skill.damage;
  const chain = resolveChainTargets(caster, enemies, baseDamage, maxTargets);
  return {
    hits: chain.map((c) => c.idx),
    damagePerHit: chain.map((c) => c.damage),
  };
}

// --- legacy aoe/cone (kept for any stragglers) ---
function _resolveLegacy(skill, caster, enemies) {
  const hits = [];
  const fx = Math.sin(caster.rotY);
  const fz = Math.cos(caster.rotY);
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const dx = e.x - caster.x;
    const dz = e.z - caster.z;
    const dist = Math.hypot(dx, dz);
    let hit = false;
    if (skill.kind === 'aoe') {
      hit = dist <= skill.radius;
    } else if (skill.kind === 'cone') {
      if (dist > 1e-6 && dist <= skill.range) {
        const dot = (dx * fx + dz * fz) / dist;
        hit = dot >= skill.arcCos;
      }
    }
    if (hit) hits.push(i);
  }
  return { hits };
}
