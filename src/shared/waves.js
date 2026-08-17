// Wave math shared by the server room and the browser-local room (GitHub
// Pages offline mode) so both sims spawn identical waves. Pure functions —
// the callers own positioning/rng.
import { SERVER } from '../server/config.js';

/** How many enemies wave `n` (1-based) activates out of the fixed pool. */
export function waveEnemyCount(wave) {
  const n = Math.max(1, Math.floor(wave));
  return Math.min(
    SERVER.enemy.waveBase + (n - 1) * SERVER.enemy.waveGrowth,
    SERVER.enemy.pool
  );
}

/** Max HP of each enemy in wave `n` — ramps slowly so deep waves feel
 *  meatier without becoming sponges. */
export function waveEnemyHp(wave) {
  const n = Math.max(1, Math.floor(wave));
  return Math.min(
    SERVER.enemy.hp + Math.floor((n - 1) * SERVER.enemy.hpGrowth),
    SERVER.enemy.hpMax
  );
}

/**
 * Pick a spawn position that keeps `minDist` away from every living player
 * (best-of-8 sampling from `randomPos`): enemies must not materialize on
 * top of someone's head at wave start. Falls back to the farthest sample.
 */
export function spawnAwayFromPlayers(players, randomPos, minDist = 12) {
  let best = randomPos();
  let bestDist = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = i === 0 ? best : randomPos();
    let dist = Infinity;
    for (const pl of players) {
      dist = Math.min(dist, Math.hypot(pl.x - p.x, pl.z - p.z));
    }
    if (dist >= minDist) return p;
    if (dist > bestDist) { bestDist = dist; best = p; }
  }
  return best;
}
