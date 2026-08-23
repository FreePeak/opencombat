// Damage direction indicator (FR-HUD-04): pure screen-angle evaluator.
// Zero DOM — rooms emit {x,z} hit sources; the client feeds them through
// dirAngleDeg and rotates an upward-pointing wedge by the result.

/**
 * Clockwise angle in degrees from screen-up (world -z) to the vector
 * player -> source, for a fixed top-down camera. CSS-rotation ready:
 * 0 = ahead/north, 90 = east, 180 = south, 270 = west.
 * Degenerate (source == player) resolves to 0; result always in [0, 360).
 */
export function dirAngleDeg(srcX, srcZ, px, pz) {
  const dx = Number(srcX) - Number(px);
  const dz = Number(srcZ) - Number(pz);
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || (dx === 0 && dz === 0)) return 0;
  const deg = Math.atan2(dx, -dz) * (180 / Math.PI);
  return (deg + 360) % 360;
}
