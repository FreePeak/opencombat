// Daily Gauntlet pure math (Step A of PRD-daily-gauntlet.md): pins the
// shared/sim/dailyRun.js contract consumers already code against —
//   - utcDateStr -> UTC 'YYYY-MM-DD'
//   - dailySeed  -> stable integer per date string
//   - dailyModifiers -> same arg deep-equal (AC1), other days differ,
//     every fixed-table row shape-valid
//   - nextStreak -> yesterday +1 / today unchanged / gap or null -> 1
//   - streakRewardXp -> monotonic, capped at day 7
// Run: node --test test/dailyRun.test.mjs
import assert from 'node:assert/strict';
import {
  utcDateStr, dailySeed, dailyModifiers, nextStreak, streakRewardXp,
} from '../src/shared/sim/dailyRun.js';

// --- utcDateStr ----------------------------------------------------------------
{
  const s = utcDateStr();
  assert.match(s, /^\d{4}-\d{2}-\d{2}$/, 'utcDateStr matches YYYY-MM-DD');
  assert.equal(s, new Date().toISOString().slice(0, 10), 'utcDateStr matches ISO slice');
  // Explicit instants stay UTC no matter the local zone.
  assert.equal(utcDateStr(Date.UTC(2026, 0, 1)), '2026-01-01', 'epoch input formats UTC');
  assert.equal(utcDateStr(new Date('2026-03-05T23:59:59Z')), '2026-03-05', 'Date input formats UTC');
}

// --- dailySeed -----------------------------------------------------------------
{
  const a = dailySeed('2026-08-22');
  assert.equal(dailySeed('2026-08-22'), a, 'same date -> same seed');
  assert.equal(typeof a, 'number', 'seed is a number');
  assert.ok(Number.isInteger(a) && a > 0, 'seed is a positive integer');

  // Different dates differ for a broad sample (hash collisions allowed but
  // must be rare, not systematic).
  const seen = new Set();
  let collisions = 0;
  for (let d = 0; d < 400; d++) {
    const ds = utcDateStr(Date.UTC(2025, 0, 1) + d * 86400000);
    const sd = dailySeed(ds);
    if (seen.has(sd)) collisions++;
    seen.add(sd);
  }
  assert.ok(collisions <= 3, 'different dates mostly hash differently');

  // Works for any well-formed YYYY-MM-DD (rollover-heavy corners included).
  for (const ds of ['2020-02-29', '1999-12-31', '2026-01-31', '2026-07-31', '2100-01-01']) {
    assert.equal(typeof dailySeed(ds), 'number', `seed ok for ${ds}`);
  }
}

// --- dailyModifiers -------------------------------------------------------------
{
  const today = utcDateStr();
  assert.deepEqual(dailyModifiers(today), dailyModifiers(today),
    'AC1: same-day calls deep-equal');
  const mods = dailyModifiers(today);
  assert.deepEqual(Object.keys(mods).sort(),
    ['description', 'enemyCountBonus', 'enemyHpMul', 'enemySpeedMul', 'label'].sort(),
    'modifiers carry the full consumer-facing shape');

  // Numeric seeds accepted too: same number -> same row.
  assert.deepEqual(dailyModifiers(123456789), dailyModifiers(123456789),
    'numeric seed path is deterministic');

  // Several different-day sampled pairs: at least one must differ.
  const days = [];
  for (let d = 0; d < 60; d++) days.push(utcDateStr(Date.UTC(2026, 7, 1) + d * 86400000));
  let differingPairs = 0;
  for (let i = 0; i + 1 < days.length; i++) {
    const x = dailyModifiers(days[i]);
    const y = dailyModifiers(days[i + 1]);
    if (!deepEqMods(x, y)) differingPairs++;
  }
  assert.ok(differingPairs >= 1, 'at least one consecutive-day pair differs');
  // Sanity: not ALL pairs differ either way is fine, but a spread exists.
  const uniq = new Set(days.map((d) => JSON.stringify(dailyModifiers(d))));
  assert.ok(uniq.size >= 2 && uniq.size <= days.length, 'sample spans multiple rows');

  // Every fixed-table row (probed via numeric seeds) is shape-valid.
  const rows = new Map();
  for (let seed = 0; seed < 64; seed++) {
    const m = dailyModifiers(seed);
    rows.set(JSON.stringify(m), true);
    assert.ok(Number.isFinite(m.enemyHpMul) && m.enemyHpMul > 0, 'enemyHpMul finite > 0');
    assert.ok(Number.isFinite(m.enemySpeedMul) && m.enemySpeedMul > 0, 'enemySpeedMul finite > 0');
    assert.ok(Number.isFinite(m.enemyCountBonus) && m.enemyCountBonus > 0, 'enemyCountBonus finite > 0');
    assert.ok(typeof m.label === 'string' && m.label.length > 0,
      'label is a non-empty string');
    assert.ok(typeof m.description === 'string' && m.description.length > 0,
      'description is a non-empty string');
  }
  assert.ok(rows.size >= 7, `table holds >= 7 distinct rows (got ${rows.size})`);
}

function deepEqMods(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- nextStreak ------------------------------------------------------------------
{
  const T = utcDateStr();
  const Y = utcDateStr(Date.now() - 86400000); // exactly one UTC day back
  assert.equal(nextStreak(null, T, 0), 1, 'never played -> 1');
  assert.equal(nextStreak(Y, T, 5), 6, 'played exactly yesterday -> +1');
  assert.equal(nextStreak(T, T, 4), 4, 'already played today -> unchanged');
  assert.equal(nextStreak('2020-01-01', T, 99), 1, 'old gap resets to 1');

  // Month rollover.
  assert.equal(nextStreak('2026-07-31', '2026-08-01', 3), 4, 'month rollover counts');
  assert.equal(nextStreak('2026-06-30', '2026-07-01', 41), 42, 'June->July rollover counts');
  // Year rollover.
  assert.equal(nextStreak('2025-12-31', '2026-01-01', 9), 10, 'year rollover counts');
  assert.equal(nextStreak('2024-12-31', '2025-01-01', 0), 1, 'leap-year-edge rollover counts');
  // Two-day gap inside a month still resets.
  assert.equal(nextStreak('2026-08-19', '2026-08-21', 7), 1, 'skipped a day -> reset to 1');
}

// --- streakRewardXp ---------------------------------------------------------------
{
  let prev = 0;
  for (let s = 1; s <= 10; s++) {
    const xp = streakRewardXp(s);
    assert.ok(Number.isInteger(xp) && xp > 0, `day ${s} reward is a positive int`);
    assert.ok(xp >= prev, `day ${s} reward is monotonic non-decreasing`);
    prev = xp;
  }
  const cap = streakRewardXp(7);
  assert.equal(streakRewardXp(8), cap, 'capped beyond day 7');
  assert.equal(streakRewardXp(100), cap, 'long streaks stay capped');
  assert.equal(streakRewardXp(1), 100, 'day 1 pays 100');
}

console.log('ok — dailyRun.test.mjs: utcDateStr UTC format, dailySeed stability, dailyModifiers determinism/table shape (AC1), nextStreak transitions incl. month/year rollover, streakRewardXp monotonic cap');
process.exit(0);
