// Leveling + upgrade cards — shared by the server (authoritative XP / level
// + card selection) and by the client (HUD, card overlay) so both sides agree
// on the level curve, the card pool and the seeded rollout.
//
// All helpers are pure — same inputs -> same outcomes on the server and in the
// browser, like src/shared/skills.js / combat.js.
//
// Spec: EXPANSION_PLAN.md Phase 4:
//   xpForLevel, seeded rollUpgrades -> 3 choices, ~16 upgrades (passives +
//   skill-specific), PlayerState gains level / xp / upgrades / pendingChoices,
//   10s auto-pick so PvP never stalls.

import { SERVER } from '../server/config.js';
import { classStats } from './skills.js';

// ---------------------------------------------------------------------------
// XP curve
// ---------------------------------------------------------------------------

/**
 * Total cumulative XP required to REACH `level` (1-based).
 * Level 1 needs 0 XP; every subsequent level costs more:
 *   100 + 150 + 200 + 250 + ...  (growth 50 per level).
 * Formula: 100*n + 25*n*(n-1)  where n = level-1.
 *   1->0, 2->100, 3->250, 4->450, 5->700, 6->1000 ...
 */
export function xpForLevel(level) {
  const l = Math.max(1, Math.floor(level));
  if (l <= 1) return 0;
  const n = l - 1;
  return 100 * n + 25 * n * (n - 1);
}

/** Level that `xp` amount corresponds to (highest level with xpForLevel <= xp). */
export function levelForXp(xp) {
  const x = Math.max(0, xp);
  let lvl = 1;
  while (xpForLevel(lvl + 1) <= x) lvl++;
  return lvl;
}

/** XP still needed to reach the NEXT level from `xp`. */
export function xpToNextLevel(xp) {
  const lvl = levelForXp(xp);
  return xpForLevel(lvl + 1) - Math.max(0, xp);
}

// ---------------------------------------------------------------------------
// Upgrade definitions (~16: passives + skill-specific)
// ---------------------------------------------------------------------------

export const UPGRADES = [
  // ---- passives (8) ----
  { id: 'vitality',      name: 'Vitality',     desc: '+30 Max HP',               maxStacks: 5, kind: 'passive', bonuses: { hp: 30 } },
  { id: 'swift',         name: 'Swift',        desc: '+12% Move Speed',           maxStacks: 3, kind: 'passive', bonuses: { speedMult: 0.12 } },
  { id: 'heavy_hand',    name: 'Heavy Hand',   desc: '+1 Melee Damage',           maxStacks: 5, kind: 'passive', bonuses: { meleeDamage: 1 } },
  { id: 'sharpshooter',  name: 'Sharpshooter', desc: '+1 Ranged Damage',          maxStacks: 5, kind: 'passive', bonuses: { rangedDamage: 1 } },
  { id: 'quick_draw',    name: 'Quick Draw',   desc: '-15% Attack Cooldown',     maxStacks: 3, kind: 'passive', bonuses: { attackCdMult: -0.15 } },
  { id: 'focused',       name: 'Focused',      desc: '-20% Skill Cooldown',      maxStacks: 3, kind: 'passive', bonuses: { skillCdMult: -0.20 } },
  { id: 'looter',        name: 'Looter',       desc: '+40% Pickup Radius',        maxStacks: 2, kind: 'passive', bonuses: { pickupRadiusMult: 0.40 } },
  { id: 'scholar',       name: 'Scholar',      desc: '+20% XP Gain',              maxStacks: 3, kind: 'passive', bonuses: { xpMult: 0.20 } },

  // ---- skill-specific (8) — 2 per class ----
  { id: 'bash_damage',     name: 'Shield Breaker', desc: 'Bash +1 Damage',         maxStacks: 3, kind: 'skill', forClass: 0, bonuses: { bashDamage: 1 } },
  { id: 'bash_stun',       name: 'Concussive Bash',desc: 'Bash +0.5s Stun',        maxStacks: 3, kind: 'skill', forClass: 0, bonuses: { bashStunMs: 500 } },
  { id: 'multishot_extra', name: 'Volley',         desc: 'Multishot +2 Arrows',    maxStacks: 3, kind: 'skill', forClass: 1, bonuses: { multishotExtra: 2 } },
  { id: 'multishot_dmg',   name: 'Piercing Arrows',desc: 'Multishot +1 Damage',    maxStacks: 3, kind: 'skill', forClass: 1, bonuses: { multishotDamage: 1 } },
  { id: 'firewave_extra',  name: 'Inferno',        desc: 'Firewave +1 Fireball',   maxStacks: 2, kind: 'skill', forClass: 2, bonuses: { firewaveExtra: 1 } },
  { id: 'firewave_burn',   name: 'Sear',           desc: 'Firewave Burn +1 Dmg',   maxStacks: 3, kind: 'skill', forClass: 2, bonuses: { firewaveBurn: 1 } },
  { id: 'chain_extra',     name: 'Overcharge',     desc: 'Chain +1 Target',        maxStacks: 2, kind: 'skill', forClass: 3, bonuses: { chainExtra: 1 } },
  { id: 'chain_damage',    name: 'Chain Power',    desc: 'Chain +0.5 Base Dmg',    maxStacks: 3, kind: 'skill', forClass: 3, bonuses: { chainDamage: 0.5 } },
];

export function getUpgrade(id) {
  return UPGRADES.find((u) => u.id === id) || null;
}

// seeded RNG (same as GameScene / LocalRoom)
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Count helper: how many times `id` appears in the owned map/array/object.
 * Accepts: Map<string,number>, MapSchema, plain object {id:count}, Array<string>, null.
 */
export function countOwned(owned, id) {
  if (!owned) return 0;
  // Map or MapSchema (both have .get)
  if (typeof owned.get === 'function') return owned.get(id) || 0;
  if (Array.isArray(owned)) return owned.filter((x) => x === id).length;
  if (typeof owned === 'object') return owned[id] || 0;
  return 0;
}

function ownedCount(owned, id) {
  return countOwned(owned, id);
}

/**
 * Seeded roll of 3 distinct upgrade choices.
 * @param {number|string} seed — number or string (hashed)
 * @param {number} character — 0..3 (class index)
 * @param {Map|Object|Array|null} owned — already-owned counts for maxStacks filtering
 * @returns {string[]} 3 ids (or fewer if the filtered pool is smaller)
 */
export function rollUpgrades(seed, character, owned) {
  const seedNum = typeof seed === 'string' ? hashString(seed) : (seed >>> 0);
  const rng = makeRng(seedNum || 1);

  // Filter: not at maxStacks, and class matches (or passive)
  let pool = UPGRADES.filter((u) => {
    const c = ownedCount(owned, u.id);
    if (c >= (u.maxStacks ?? 99)) return false;
    if (u.forClass !== undefined && u.forClass !== character) return false;
    return true;
  });

  // Deterministic shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }

  const picks = pool.slice(0, 3).map((u) => u.id);
  return picks;
}

// ---------------------------------------------------------------------------
// Effective stat / skill helpers (apply upgrades)
// ---------------------------------------------------------------------------

/**
 * Aggregate bonus totals from an owned collection for quick stat math.
 * Returns an object with summed bonuses: { hp, speedMult, meleeDamage, ... }
 */
export function aggregateBonuses(owned) {
  const out = {
    hp: 0,
    speedMult: 0,
    meleeDamage: 0,
    rangedDamage: 0,
    attackCdMult: 0,
    skillCdMult: 0,
    pickupRadiusMult: 0,
    xpMult: 0,
    bashDamage: 0,
    bashStunMs: 0,
    multishotExtra: 0,
    multishotDamage: 0,
    firewaveExtra: 0,
    firewaveBurn: 0,
    chainExtra: 0,
    chainDamage: 0,
  };
  if (!owned) return out;

  // Map or MapSchema both have .entries + .get
  const isMapLike = owned && typeof owned.entries === 'function' && typeof owned.get === 'function';
  const entries = isMapLike ? [...owned.entries()]
    : Array.isArray(owned) ? (() => {
        const m = new Map();
        for (const id of owned) m.set(id, (m.get(id) || 0) + 1);
        return [...m.entries()];
      })()
    : typeof owned === 'object' ? Object.entries(owned)
    : [];

  for (const [id, count] of entries) {
    const def = getUpgrade(id);
    if (!def || !def.bonuses || count <= 0) continue;
    for (const [k, v] of Object.entries(def.bonuses)) {
      if (out[k] !== undefined) out[k] += v * count;
      else out[k] = v * count;
    }
  }
  return out;
}

/**
 * Effective max HP for a character after vitality stacks (base from CLASS_STATS + bonuses).
 * @param {number} character
 * @param {Map|Object|Array} owned
 * @returns {number}
 */
export function effectiveMaxHp(character, owned) {
  const base = classStats(character).hp;
  const b = aggregateBonuses(owned);
  return base + (b.hp || 0);
}

/**
 * Effective movement speed multiplier from 'swift' stacks.
 * @param {Map|Object|Array} owned
 * @returns {number} 1 + total swift bonus (e.g. 1.24 for 2 stacks)
 */
export function effectiveSpeedMult(owned) {
  const b = aggregateBonuses(owned);
  return 1 + (b.speedMult || 0);
}

/**
 * Effective attack cooldown multiplier (clamped to at least 0.4x so it never hits 0).
 */
export function effectiveAttackCdMult(owned) {
  const b = aggregateBonuses(owned);
  const mult = 1 + (b.attackCdMult || 0);
  return Math.max(0.4, mult);
}

/**
 * Effective skill cooldown multiplier.
 */
export function effectiveSkillCdMult(owned) {
  const b = aggregateBonuses(owned);
  const mult = 1 + (b.skillCdMult || 0);
  return Math.max(0.4, mult);
}

/**
 * Totally effective skill definition after skill-specific upgrades.
 * Returns a shallow clone of `skill` with modified damage / counts / stun.
 * @param {object} skill — base skill from SKILLS[character]
 * @param {Map|Object|Array} owned
 * @returns {object} effective skill
 */
export function effectiveSkill(skill, owned) {
  const b = aggregateBonuses(owned);
  const out = { ...skill };
  if (skill.kind === 'bash') {
    out.damage = skill.damage + (b.bashDamage || 0);
    out.stunDurationMs = (skill.stunDurationMs || 1000) + (b.bashStunMs || 0);
  } else if (skill.kind === 'multishot') {
    out.damage = skill.damage + (b.multishotDamage || 0);
    out.arrowCount = (skill.arrowCount || 5) + (b.multishotExtra || 0);
  } else if (skill.kind === 'firewave') {
    out.fireballCount = (skill.fireballCount || 3) + (b.firewaveExtra || 0);
    out.burnDamage = (skill.burnDamage || 1) + (b.firewaveBurn || 0);
  } else if (skill.kind === 'chainlight') {
    out.maxTargets = (skill.maxTargets || 4) + (b.chainExtra || 0);
    out.damage = skill.damage + (b.chainDamage || 0);
  }
  return out;
}

/**
 * Effective melee damage after heavy_hand stacks.
 */
export function effectiveMeleeDamage(character, owned) {
  const base = classStats(character).meleeDamage ?? SERVER.player.attackDamage;
  const b = aggregateBonuses(owned);
  return base + (b.meleeDamage || 0);
}

/**
 * Effective ranged damage after sharpshooter stacks.
 */
export function effectiveRangedDamage(character, owned) {
  const base = classStats(character).rangedDamage ?? SERVER.player.rangedDamage ?? 1;
  const b = aggregateBonuses(owned);
  return base + (b.rangedDamage || 0);
}

/**
 * XP gain after scholar stacks.
 * @param {number} baseXp
 * @param {Map|Object|Array} owned
 */
export function effectiveXp(baseXp, owned) {
  const b = aggregateBonuses(owned);
  return Math.floor(baseXp * (1 + (b.xpMult || 0)));
}

/**
 * Pickup radius multiplier (for Looter).
 */
export function effectivePickupMult(owned) {
  const b = aggregateBonuses(owned);
  return 1 + (b.pickupRadiusMult || 0);
}

export const AUTO_PICK_MS = 10000;
