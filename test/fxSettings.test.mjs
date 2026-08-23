// FX settings (FR-UX-01): resolveFxSettings pure evaluator + storage-backed
// load/save helpers powering the settings strip (volume slider, reduced FX).
// Run: node --test test/fxSettings.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveFxSettings, loadFxSettings, saveFxSettings, FX_KEY } from '../src/shared/sim/fxSettings.js';

test('defaults: full volume, full fx when nothing saved', () => {
  assert.deepEqual(resolveFxSettings(), {
    volume: 1, reducedFx: false, particleScale: 1, shakeScale: 1, shadows: true,
  });
});

test('volume clamps into 0..1 and coerces junk to 0', () => {
  assert.equal(resolveFxSettings({ volume: 1.5 }).volume, 1);
  assert.equal(resolveFxSettings({ volume: -3 }).volume, 0);
  assert.equal(resolveFxSettings({ volume: 0.4 }).volume, 0.4);
  assert.equal(resolveFxSettings({ volume: 'abc' }).volume, 0);
  assert.equal(resolveFxSettings({ volume: NaN }).volume, 0);
});

test('reducedFx scales particles, removes shake, disables the shadow pass', () => {
  const s = resolveFxSettings({ volume: 0.5, reducedFx: true });
  assert.equal(s.reducedFx, true);
  assert.equal(s.particleScale, 0.35);
  assert.equal(s.shakeScale, 0);
  assert.equal(s.shadows, false); // FR-UX-01 completion: shadow pass ~2x geometry cost
});

test('load/save round-trip through an injected storage', () => {
  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(loadFxSettings(store), { volume: 1, reducedFx: false });
  saveFxSettings(store, { volume: 0.25, reducedFx: true });
  assert.equal(mem.get(FX_KEY), JSON.stringify({ volume: 0.25, reducedFx: true }));
  assert.deepEqual(loadFxSettings(store), { volume: 0.25, reducedFx: true });
});

test('load tolerates corrupt JSON and junk fields', () => {
  let raw = '{broken';
  const store = { getItem: () => raw, setItem: () => {} };
  assert.deepEqual(loadFxSettings(store), { volume: 1, reducedFx: false });
  raw = JSON.stringify({ volume: 'x', reducedFx: 'yes', extra: 1 });
  assert.deepEqual(loadFxSettings(store), { volume: 1, reducedFx: false });
});
