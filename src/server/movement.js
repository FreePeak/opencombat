// Server-authoritative per-player movement step, extracted as a pure function
// so the move-while-attacking contract is unit-testable without booting a
// room. GameRoom.movePlayers calls this once per living player per tick.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Integrate one player's position from the last input intent.
 *
 * RC7 — movement is NEVER blocked by attacking/casting: the player can move
 * and attack at the same time. The swing/cast only overrides the animation
 * (GameRoom keeps anim='attack'/'skill' during animUntil); it does not freeze
 * the position. (An earlier revision rooted the caster here, which is what
 * made "attack while moving" feel broken.)
 *
 * @returns {{x:number, z:number, rotY:number}} the updated transform
 */
export function stepPlayer(x, z, rotY, dirX, dirZ, speed, dt, half) {
  const nx = clamp(x + dirX * speed * dt, -half, half);
  const nz = clamp(z + dirZ * speed * dt, -half, half);
  const nrot = (dirX || dirZ) ? Math.atan2(dirX, dirZ) : rotY;
  return { x: nx, z: nz, rotY: nrot };
}
