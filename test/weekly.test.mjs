import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  utcWeekKey, weeklySeed, weeklyModifiers, weeklyRewardXp, mergeWeekly
} from '../src/shared/sim/weeklyRun.js';
import { ELITE_AFFIXES } from '../src/shared/sim/elites.js';

test('utcWeekKey ISO-8601 semantics', () => {
  assert.equal(utcWeekKey(Date.UTC(2026, 7, 22)), '2026-W34'); // Sat Aug 22 2026
  // Monday starts the week
  assert.equal(utcWeekKey(Date.UTC(2026, 7, 17)), '2026-W34'); // Mon Aug 17
  assert.equal(utcWeekKey(Date.UTC(2026, 7, 16)), '2026-W33'); // Sun Aug 16 belongs to prior week
  // Year boundary: Jan 1 2026 is a Thursday -> W1 contains it.
  const k = utcWeekKey(Date.UTC(2026, 0, 1));
  assert.equal(k, '2026-W01');
  // Late Dec days that belong to next year's W1 (Dec 29 2026 is a Tuesday).
  const k2 = utcWeekKey(Date.UTC(2026, 11, 29));
  assert.ok(['2026-W53', '2027-W01'].includes(k2), `got ${k2}`);
});

test('seed + modifiers deterministic; stacks exceed single rows', () => {
  const wk = utcWeekKey();
  assert.equal(weeklySeed(wk), weeklySeed(wk));
  const a = weeklyModifiers(wk);
  const b = weeklyModifiers(wk);
  assert.deepEqual(a, b);
  assert.equal(a.stack.length, 3, 'three stacked rows');
  assert.equal(new Set(a.stack).size, 3, 'rows distinct');
  // composition >= max single-row magnitude for hp and count
  const maxHp = Math.max(...ELITE_AFFIXES.map(r => r.hpMul));
  assert.ok(a.enemyHpMul >= maxHp, `${a.enemyHpMul} >= ${maxHp}`);
  assert.ok(a.enemyCountBonus >= 3);
  // different weeks differ somewhere in a few samples
  const others = ['2026-W01', '2026-W02', '2030-W10'].map(weeklyModifiers);
  assert.ok(others.some(o => o.label !== a.label || o.enemyHpMul !== a.enemyHpMul));
});

test('weeklyRewardXp monotonic ladder', () => {
  const xs = [0, 499, 500, 1499, 1500, 3000, 4999, 9000].map(weeklyRewardXp);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1]);
  assert.equal(weeklyRewardXp(-5), 150); // floor tier still pays once
});

test('mergeWeekly same-week max, new-week replace', () => {
  const wk = '2026-W34';
  assert.deepEqual(
    mergeWeekly(undefined, wk, 100),
    { week: wk, bestScore: 100, lastPlayed: wk }
  );
  assert.deepEqual(
    mergeWeekly({ week: wk, bestScore: 300 }, wk, 100),
    { week: wk, bestScore: 300, lastPlayed: wk }
  );
  assert.deepEqual(
    mergeWeekly({ week: wk, bestScore: 50 }, wk, 120),
    { week: wk, bestScore: 120, lastPlayed: wk }
  );
  const merged = mergeWeekly({ week: '2026-W33', bestScore: 999 }, wk, 40);
  assert.equal(merged.bestScore, 40, 'new week resets baseline');
});
