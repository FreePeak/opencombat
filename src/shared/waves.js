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

/**
 * Activate wave `n` over a fixed enemy pool (P1.3 Slice 4 stretch, design doc
 * section 1 D1). Mutates each enemy slot in place: the first
 * waveEnemyCount(n) slots come alive at waveEnemyHp(n), positioned by
 * samplePos away from living players (best-of-8 via spawnAwayFromPlayers);
 * the rest drop to hp 0 so ids stay stable across waves. Caller owns the
 * per-enemy anim/stun map clears through onSlotReset (invoked once per slot,
 * before placement) and sets `state.wave = n` itself.
 *
 * @param {Array|ArraySchema} enemies - fixed enemy pool, mutated in place
 * @param {number} n - 1-based wave number
 * @param {Map|MapSchema|Array} players - room seats; only hp > 0 seats are
 *   treated as spawn hazards
 * @param {(players: object[]) => {x:number,z:number}} samplePos - raw
 *   position sampler (GameRoom: uniform square minus margin; LocalRoom:
 *   seeded LCG circle)
 * @param {(enemy: object) => void} [onSlotReset] - called once per slot
 *   before placement (rooms clear their anim/stun map entries keyed by the
 *   enemy object here)
 * @returns {{count:number, hp:number}} the activated count + per-enemy HP
 *   (callers log wave_spawn with them)
 */
export function activateWave(enemies, n, players, samplePos, onSlotReset) {
  const count = waveEnemyCount(n);
  const hp = waveEnemyHp(n);
  // Only living seats are spawn hazards (corpses are ignored by both rooms).
  const hazards = [];
  for (const p of typeof players.values === 'function' ? players.values() : players) {
    if (p.hp > 0) hazards.push(p);
  }
  enemies.forEach((enemy, i) => {
    onSlotReset?.(enemy);
    if (i < count) {
      const p = spawnAwayFromPlayers(hazards, samplePos);
      enemy.x = p.x;
      enemy.z = p.z;
      enemy.hp = hp;
      enemy.anim = 'idle';
    } else {
      enemy.hp = 0;
    }
  });
  return { count, hp };
}
