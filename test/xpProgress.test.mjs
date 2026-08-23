// XP progress bar (PRD.md FR-HUD-01): xpProgress(level, xp) pure evaluator
// Run: node --test test/xpProgress.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { xpProgress, xpForLevel } from '../src/shared/progression.js';

test('AC1 exact pct math at known thresholds', () => {
  const l1 = xpForLevel(1);
  const l2 = xpForLevel(2);
  // fresh level-1 player with zero xp: 0 into the bracket
  assert.deepEqual(xpProgress(1, l1), { level: 1, into: 0, need: l2 - l1, pct: 0 });
  // halfway through the bracket
  const half = xpProgress(1, l1 + Math.floor((l2 - l1) / 2));
  assert.equal(half.into, Math.floor((l2 - l1) / 2));
  assert.equal(half.need, l2 - l1);
  assert.ok(half.pct > 0.4 && half.pct < 0.6);
});

test('AC1 exactly at next threshold reads as full bar for current level', () => {
  const p = xpProgress(1, xpForLevel(2) - 1);
  assert.ok(p.pct < 1);
  assert.ok(p.pct > 0);
});

test('AC1 clamps: xp below current threshold -> pct 0; runaway xp stays <= 1', () => {
  assert.equal(xpProgress(3, 0).pct, 0);
  const big = xpProgress(1, xpForLevel(50));
  assert.equal(big.pct, 1);
});

test('AC1 monotonic within a bracket and consistent across calls (determinism)', () => {
  let prev = -1;
  for (let extra = 0; extra <= 100; extra += 10) {
    const p = xpProgress(2, xpForLevel(2) + extra);
    assert.ok(p.pct >= prev);
    prev = p.pct;
    assert.deepEqual(xpProgress(2, xpForLevel(2) + extra), p);
  }
});
