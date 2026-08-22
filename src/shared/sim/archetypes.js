// Enemy archetype system (PRD-enemy-archetypes.md): from ARCHETYPE_FROM_WAVE
// onward, live enemy slots carry a deterministic archetype that changes stats
// and pursuit feel — Rusher (fast, frail), Tank (slow, fat, shrugs off most
// knockback). Pure module — no imports — so GameRoom, LocalRoom, the client
// renderer and tests share ONE source of truth, exactly like elites.js.
//
// Selection is index math over (wave + slot), never RNG, which is what keeps
// online and offline waves structurally identical without coordination.
// Elite waves keep slot 0 archetype-free: the ELITE is the wave's spike and
// must stay readable on its own (PRD AC5); archetypes dress the other slots.
//
// Server contract:
//   - spawn paths call markArchetypes(state.enemies, n, { liveCount,
//     eliteWave }) AFTER base/daily HP stamping and AFTER the elite block;
//     chase ticks look up archetypeByName(e.archetype).speedMul per enemy
//   - combat hooks route knockback through combatBook.knockbackAgainst,
//     which multiplies by knockbackMul (elite Bulwark immunity still wins)
// Client contract:
//   - Enemy entity scales/tints off state.archetype ('' = plain chaser)

export const ARCHETYPE_FROM_WAVE = 3;

// Shooter (PRD-enemy-archetypes.md Shooter cycle): keeps preferred distance
// and fires arrows (kind 'arrow', ownerIsPlayer=false) at the nearest living
// player. Introduced later than Rusher/Tank so waves 3-4 teach movement
// variety first; ranged threat arrives once players have upgrades to answer.
export const SHOOTER_FROM_WAVE = 5;
export const SHOOTER_PREFERRED_RANGE = 6;
export const SHOOTER_KITE_RANGE = 4;
export const SHOOTER_FIRE_COOLDOWN_MS = 2500;
export const SHOOTER_KITE_SPEED_MUL = 0.8;

// PRD numbers: Rusher speed x1.4 / hp x0.75; Tank hp x2.0 / speed x0.7 /
// knockback x0.25. Chaser is the implicit default ('' -> no entry).
export const ARCHETYPES = [
  { name: 'Rusher',  hpMul: 0.75, speedMul: 1.4,  knockbackMul: 1.0 },
  { name: 'Tank',    hpMul: 2.0,  speedMul: 0.7,  knockbackMul: 0.25 },
  { name: 'Shooter', hpMul: 1.0,  speedMul: 0.85, knockbackMul: 1.0 },
];

const BY_NAME = new Map(ARCHETYPES.map((a) => [a.name, a]));

/**
 * Deterministic archetype tag for `slot` of `wave` (1-based). Waves below
 * ARCHETYPE_FROM_WAVE are pure chasers (onboarding). Pattern: with
 * k = (wave + slot) % 5, k in {0,1} -> Rusher, k === 2 -> Tank,
 * k === 3 -> Shooter (from SHOOTER_FROM_WAVE only — waves 3-4 keep melee-only
 * variety), else ''. Shooters roll '' below their gate so early waves never
 * spawn a ranged threat before the player has tools.
 * @returns {'Rusher'|'Tank'|'Shooter'|''}
 */
export function archetypeForSlot(wave, slot) {
  if (!Number.isInteger(wave) || !Number.isInteger(slot)) return '';
  if (wave < ARCHETYPE_FROM_WAVE) return '';
  const k = (((wave + slot) % 5) + 5) % 5;
  if (k === 0 || k === 1) return 'Rusher';
  if (k === 2) return 'Tank';
  if (k === 3 && wave >= SHOOTER_FROM_WAVE) return 'Shooter';
  return '';
}

/** Table row for `name`, or null for ''/unknown (elites are not archetypes). */
export function archetypeByName(name) {
  if (!name) return null;
  return BY_NAME.get(name) || null;
}

/**
 * Stamp archetype tags + scaled hp across the LIVE prefix of the pool.
 * Callers own ordering: run this after base/daily HP stamping and after the
 * elite block, passing eliteWave=true so slot 0 (the ELITE) is left alone.
 * Slots resolving to '' get their tag CLEARED — revived pools never carry a
 * previous wave's identity. Dead slots beyond liveCount are untouched.
 *
 * @param {Array|ArraySchema} enemies - fixed pool, mutated in place
 * @param {number} n - 1-based wave number
 * @param {{liveCount?: number, eliteWave?: boolean}} [opts]
 * @returns {number} how many slots got a non-empty archetype
 */
export function markArchetypes(enemies, n, opts = {}) {
  const liveCount = Number.isInteger(opts.liveCount) ? opts.liveCount : enemies.length;
  let marked = 0;
  for (let i = 0; i < liveCount; i++) {
    const e = enemies[i];
    if (!e || !(e.hp > 0)) continue;
    if (opts.eliteWave && i === 0) continue; // the spike stays pure (PRD AC5)
    const tag = archetypeForSlot(n, i);
    e.archetype = tag;
    if (!tag) continue;
    const arch = BY_NAME.get(tag);
    e.hp = Math.max(1, Math.ceil(e.hp * arch.hpMul));
    marked++;
  }
  return marked;
}
