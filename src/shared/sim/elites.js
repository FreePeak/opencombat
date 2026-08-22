// Elite affix system (P2.6): every Nth wave spawns one ELITE enemy carrying a
// named affix that changes its stats/behavior. Pure module — no imports — so
// GameRoom, LocalRoom, client rendering and tests all share ONE source of
// truth. Affix selection is deterministic per wave number (no RNG), which is
// what lets online and offline modes agree structurally without coordination.
//
// Server contract:
//   - spawn path marks slot 0 via applyElite(state, affixForWave(n), baseMaxHp)
//   - chase ticks look up affixByName(state.elite).speedMul per enemy
//   - combat hooks read knockbackImmune / vampiricPct / volatile
// Client contract:
//   - Enemy entity scales by ELITE_SCALE and tints when state.elite !== ''

export const ELITE_EVERY_N_WAVES = 5;
export const ELITE_SCALE = 1.8;

// PRD numbers: Swift +60% speed; Bulwark +150% hp (+ knockback immunity);
// Vampiric heals 50% of damage dealt; Volatile explodes on death after an
// 800ms fuse (r=3, 25 dmg). Non-flagship stats get modest bumps so every
// elite is a threat but never a wall.
export const ELITE_AFFIXES = [
  { name: 'Swift',    hpMul: 1.0,  speedMul: 1.6, knockbackImmune: false, vampiricPct: 0,   volatile: null },
  { name: 'Bulwark',  hpMul: 2.5,  speedMul: 1.0, knockbackImmune: true,  vampiricPct: 0,   volatile: null },
  { name: 'Vampiric', hpMul: 1.25, speedMul: 1.05, knockbackImmune: false, vampiricPct: 0.5, volatile: null },
  { name: 'Volatile', hpMul: 1.5,  speedMul: 1.0, knockbackImmune: false, vampiricPct: 0,   volatile: { radius: 3, damage: 25, fuseMs: 800 } },
];

export function isEliteWave(n) {
  return Number.isInteger(n) && n > 0 && n % ELITE_EVERY_N_WAVES === 0;
}

export function affixForWave(n) {
  if (!isEliteWave(n)) return null;
  const idx = ((n / ELITE_EVERY_N_WAVES) - 1) % ELITE_AFFIXES.length;
  return ELITE_AFFIXES[idx].name;
}

export function affixByName(name) {
  return ELITE_AFFIXES.find(a => a.name === name) ?? null;
}

// Marks an enemy-state-like object as elite. `baseMaxHp` is the wave's normal
// max hp (waves.waveEnemyHp(n)); actual hp is scaled by the affix. Returns the
// affix object for caller convenience.
export function applyElite(enemy, affixName, baseMaxHp) {
  const affix = affixByName(affixName);
  if (!affix || !enemy) return null;
  enemy.elite = affix.name;
  enemy.hp = Math.ceil(baseMaxHp * affix.hpMul);
  return affix;
}
