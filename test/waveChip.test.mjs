// Wave-progress chip (FR-HUD-03): waveChip(wave, finaleWave) pure evaluator
// driving the run-arc legibility chip in the HUD.
// Run: node --test test/waveChip.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { waveChip } from '../src/shared/waves.js';

test('mid-run: label carries N/M, pct is exact fraction', () => {
  assert.deepEqual(waveChip(4, 12), { label: 'WAVE 4/12', pct: 4 / 12, isFinale: false });
});

test('finale wave flags isFinale so the client can style it', () => {
  const c = waveChip(12, 12);
  assert.equal(c.isFinale, true);
  assert.equal(c.pct, 1);
});

test('beyond-finale input clamps pct at 1', () => {
  const c = waveChip(15, 12);
  assert.equal(c.pct, 1);
  assert.equal(c.label, 'WAVE 15/12');
});

test('endless mode (finaleWave 0): no fraction, no pct, never finale', () => {
  assert.deepEqual(waveChip(7, 0), { label: 'WAVE 7', pct: 0, isFinale: false });
});
