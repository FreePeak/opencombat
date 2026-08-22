// Combat Radar projection math (PRD-combat-radar.md, Cycle 19): maps world
// positions to canvas-normalized [0,1] coordinates on a self-centered radar
// of a square arena with half-extent `span`. Pure — no imports, no DOM, no
// state; the client renderer (src/ui/CombatRadar.js) owns all drawing.
//
// Consumers:
//   src/ui/CombatRadar.js -> blips for enemies/allies each frame
//   test/radar.test.mjs   -> headless contract pin

/**
 * @param entities  iterable of {x, z, ...} (kind/color carried through untouched)
 * @param self      {x, z} — always projects to (0.5, 0.5)
 * @param span      visible half-extent in world units around self
 * @returns [{ u, v, clamped }] — clamped=true marks blips pushed onto the rim
 */
export function projectRadar(entities, self, span) {
  const out = [];
  if (!entities) return out;
  for (const e of entities) {
    const dx = e.x - self.x;
    const dz = e.z - self.z;
    // Beyond-span distance along either axis pushes the blip onto the rim.
    let u = 0.5 + dx / (2 * span);
    let v = 0.5 + dz / (2 * span);
    const clamped = u < 0 || u > 1 || v < 0 || v > 1;
    if (clamped) {
      // Scale toward the rim preserving direction from center.
      const du = u - 0.5;
      const dv = v - 0.5;
      const m = Math.max(Math.abs(du), Math.abs(dv));
      const s = m === 0 ? 0 : 0.5 / m;
      u = 0.5 + du * s;
      v = 0.5 + dv * s;
    }
    out.push({ u, v, clamped });
  }
  return out;
}
