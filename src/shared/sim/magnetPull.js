// Magnet power-up pull math (PRD-magnet.md): while a holder's 'magnet'
// effect is live, nearby roaming orbs drift toward them so wave-clear gem
// bursts collect themselves. Pure module — no imports — mirroring
// orbDrops/elites/archetypes so GameRoom, LocalRoom and tests share ONE
// source of truth. Rooms pass their own dt (same unit as collection loop);
// positions written here are schema objects mutated in place.
//
// Rules:
//   - only orbs STRICTLY inside `radius` move (boundary = no-op, mirrors the
//     collection loop's strict `<` radius test)
//   - step = min(speed * dt, distance) — never overshoots the holder
//   - FIRST holder in iteration order wins per orb per tick (same
//     one-holder-per-orb rule the collection loop uses for players)

/**
 * Drift `orbs` toward the first holder within `radius`.
 *
 * @param {Array|ArraySchema} orbs - orb pool, mutated in place
 * @param {Iterable<{x:number,z:number}>} holders - living magnet holders in
 *   insertion order
 * @param {number} radius - pull radius (world units)
 * @param {number} speed - pull speed (units per second)
 * @param {number} dt - fixed timestep seconds (caller's clock)
 * @returns {number} how many orbs moved this call
 */
export function pullOrbs(orbs, holders, radius, speed, dt) {
  if (!orbs || !holders || !(radius > 0) || !(speed > 0) || !(dt > 0)) return 0;
  const list = [...holders];
  if (list.length === 0) return 0;
  let moved = 0;
  for (const orb of orbs) {
    if (!orb) continue;
    for (const h of list) {
      const dx = h.x - orb.x;
      const dz = h.z - orb.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= radius || dist < 1e-6) continue; // outside, or already on top
      const step = Math.min(speed * dt, dist);
      orb.x += dx / dist * step;
      orb.z += dz / dist * step;
      moved++;
      break;
    }
  }
  return moved;
}
