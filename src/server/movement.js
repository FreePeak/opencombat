// Server-authoritative per-player movement step, extracted as a pure function
// so the RC6 root-during-attack contract is unit-testable without booting a
// room. GameRoom.movePlayers calls this once per living player per tick.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Integrate one player's position from the last input intent.
 *
 * RC6 — while `attacking` (mid-swing, or mid skill-cast) the player is ROOTED:
 * position and facing are frozen even if a movement key is held, so the
 * planted-feet attack animation never skates the model across the ground and
 * "move + attack at the same time" can no longer slide the character.
 *
 * @returns {{x:number, z:number, rotY:number}} the updated transform
 */
export function stepPlayer(x, z, rotY, dirX, dirZ, speed, dt, half, attacking) {
  if (attacking) return { x, z, rotY };
  const nx = clamp(x + dirX * speed * dt, -half, half);
  const nz = clamp(z + dirZ * speed * dt, -half, half);
  const nrot = (dirX || dirZ) ? Math.atan2(dirX, dirZ) : rotY;
  return { x: nx, z: nz, rotY: nrot };
}
