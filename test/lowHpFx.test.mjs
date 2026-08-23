// Low-HP danger vignette (FR-HUD-02): lowHpFx(hp, maxHp) pure intensity
// evaluator driving the client's persistent danger overlay.
// Run: node --test test/lowHpFx.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lowHpFx } from '../src/shared/sim/lowHpFx.js';

test('healthy and dead states produce zero vignette', () => {
  assert.deepEqual(lowHpFx(100, 100), { on: false, intensity: 0 });
  assert.deepEqual(lowHpFx(50, 100), { on: false, intensity: 0 });
  // dead players get no danger overlay (gameover card owns that screen)
  assert.deepEqual(lowHpFx(0, 100), { on: false, intensity: 0 });
});

test('threshold: danger starts at exactly 30% hp', () => {
  const at = lowHpFx(30, 100);
  assert.equal(at.on, true);
  assert.equal(at.intensity, 0); // boundary: on but not yet visible
  assert.equal(lowHpFx(31, 100).on, false);
});

test('ramp: intensity grows linearly to 1 at 5% hp and clamps below', () => {
  assert.ok(Math.abs(lowHpFx(17.5, 100).intensity - 0.5) < 1e-9);
  assert.equal(lowHpFx(5, 100).intensity, 1);
  assert.equal(lowHpFx(2, 100).intensity, 1);
  assert.equal(lowHpFx(-4, 100).intensity, 0); // dead/negative -> off
});

test('defensive inputs: zero/absent maxHp never divides by zero', () => {
  assert.deepEqual(lowHpFx(10, 0), { on: false, intensity: 0 });
});
