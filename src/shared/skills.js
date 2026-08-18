// Per-character skill definitions + hit resolution, shared by the server
// (authoritative damage) and the client (HUD + VFX) so the two sides can
// never drift. Indexed by PlayerState.character (== CONFIG.characters order:
// 0 swordsman, 1 archer, 2 mage, 3 demon).
//
// Every character shares the normal melee (J). The skill (K) is the distinct
// per-character cast. `kind` selects the hit shape resolved by
// resolveSkillHits():
//   aoe  — hits every enemy within `radius` of the caster (direction-free)
//   cone — hits enemies within `range` AND inside the facing arc (arcCos)
export const SKILLS = [
  {
    key: 'whirlwind', name: 'Whirlwind', kind: 'aoe',
    radius: 3.5, damage: 2, cooldownMs: 3000, animMs: 500, color: 0xffd54f
  },
  {
    key: 'piercing', name: 'Piercing Shot', kind: 'cone',
    range: 9, arcCos: 0.85, damage: 2, cooldownMs: 2500, animMs: 450, color: 0x00e5ff
  },
  {
    key: 'nova', name: 'Arcane Nova', kind: 'aoe',
    radius: 5.0, damage: 1, cooldownMs: 4000, animMs: 550, color: 0xce93d8
  },
  {
    key: 'slam', name: 'Frenzy Slam', kind: 'cone',
    range: 3.2, arcCos: 0.25, damage: 2, cooldownMs: 1500, animMs: 400, color: 0xff8a65
  }
];

/** Fallback so an out-of-range character index still casts something sane. */
export function skillFor(character) {
  return SKILLS[character] || SKILLS[0];
}

/**
 * Pure hit resolution: returns the indices (into `enemies`) that `skill`
 * strikes when cast by `caster` ({x,z,rotY}). Server applies the damage;
 * the same function drives the client VFX so what you see is what hit.
 */
export function resolveSkillHits(skill, caster, enemies) {
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
  return hits;
}
