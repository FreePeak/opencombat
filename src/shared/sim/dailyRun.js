// Daily Gauntlet pure math (PRD-daily-gauntlet.md): UTC date string, date
// seed, per-day modifier table, consecutive-day streak transitions and the
// streak XP reward table. Shared by GameRoom (server finalize), LocalRoom
// fallback and GET /api/daily — no imports, no state, fully deterministic so
// every player on the same UTC day sees identical modifiers.

/** 'YYYY-MM-DD' for `now` (ms epoch or Date), always UTC. */
export function utcDateStr(now = Date.now()) {
  return new Date(now instanceof Date ? now.getTime() : now).toISOString().slice(0, 10);
}

/**
 * Stable integer seed from a date string: 31-mult rolling hash, same shape as
 * leveling.hashSeed. The `|| 1` guard keeps makeRng(seed) stable if a hash
 * ever collapses to 0 (parity with the rooms' seeding contract).
 */
export function dailySeed(dateStr) {
  let h = 0;
  const s = String(dateStr);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h || 1;
}

// Fixed daily modifier rows: hpMul 1–3 (tankier), speedMul 0.8–1.5 (slower or
// faster), countBonus 1–6 extra pool slots. Indexed by dailySeed % length —
// same day -> same row everywhere. Values stay strictly positive so spawned
// enemy hp/speed math never degenerates.
const MODIFIER_TABLE = [
  { enemyHpMul: 1.0, enemySpeedMul: 1.0, enemyCountBonus: 2,
    label: 'Standard Issue', description: 'No frills: today the horde fights fair.' },
  { enemyHpMul: 1.5, enemySpeedMul: 0.9, enemyCountBonus: 4,
    label: 'Fat and Slow', description: 'Tanky brutes that lumber but never stop coming.' },
  { enemyHpMul: 2.0, enemySpeedMul: 1.25, enemyCountBonus: 1,
    label: 'Elite Guard', description: 'Fewer foes, twice the muscle, quicker feet.' },
  { enemyHpMul: 1.25, enemySpeedMul: 1.4, enemyCountBonus: 3,
    label: 'Blitz Rush', description: 'Fast movers flood the arena in numbers.' },
  { enemyHpMul: 3.0, enemySpeedMul: 0.8, enemyCountBonus: 6,
    label: 'Meat Wall', description: 'A slow, endless wall of very angry meat.' },
  { enemyHpMul: 1.75, enemySpeedMul: 1.15, enemyCountBonus: 5,
    label: 'Swarm Surge', description: 'Bigger swarm, tougher swarm — bring friends.' },
  { enemyHpMul: 2.5, enemySpeedMul: 1.05, enemyCountBonus: 2,
    label: 'Iron Vanguard', description: 'Heavy hitters with a small escort.' },
  { enemyHpMul: 1.1, enemySpeedMul: 1.5, enemyCountBonus: 4,
    label: 'Sprinter Frenzy', description: 'Fragile but blisteringly quick and plentiful.' },
];

/**
 * Deterministic modifiers for `dateStrOrSeed` (a 'YYYY-MM-DD' string or a raw
 * numeric seed): returns a fresh copy of one fixed table row indexed by
 * seed % table.length, so two calls on the same argument deep-equal.
 */
export function dailyModifiers(dateStrOrSeed) {
  const seed = typeof dateStrOrSeed === 'number'
    ? dateStrOrSeed >>> 0
    : dailySeed(dateStrOrSeed);
  return { ...MODIFIER_TABLE[seed % MODIFIER_TABLE.length] };
}

// Parse strict 'YYYY-MM-DD' -> [y, m, d], or null. Pure-string validation:
// no locale/timezone drift anywhere in the streak math.
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Reject impossible dates like 2026-02-31 via round-trip.
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
    ? t : null;
}

/** The day before `dateStr` in UTC (handles month/year rollover). */
function yesterdayOf(dateStr) {
  const ymd = parseYmd(dateStr);
  if (!ymd) return null;
  return utcDateStr(new Date(ymd.getTime() - 86400000));
}

/**
 * Consecutive-day streak after playing on `todayStr` (PRD AC2):
 *   - lastPlayedDate exactly yesterday -> currentStreak + 1
 *   - lastPlayedDate === today         -> currentStreak unchanged
 *   - null / gap / malformed           -> 1
 */
export function nextStreak(lastPlayedDate, todayStr, currentStreak) {
  if (!lastPlayedDate || !parseYmd(lastPlayedDate) || !parseYmd(todayStr)) return 1;
  if (lastPlayedDate === todayStr) return currentStreak;
  if (lastPlayedDate === yesterdayOf(todayStr)) return currentStreak + 1;
  return 1;
}

/** Escalating XP for a streak of `streak` days, capped at day 7 (100/day). */
export function streakRewardXp(streak) {
  return Math.min(Math.max(1, Math.floor(streak)), 7) * 100;
}
