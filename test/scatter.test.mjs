// Pure math behind GLB nature dressing (src/client/NatureDressing.js).
// Deterministic placement must match across clients, so the sampler is
// dependency-free and unit-tested here. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLcg, sampleOpenPositions, fitScale } from '../src/tools/scatter.js';

test('makeLcg is deterministic for a given seed', () => {
  const a = makeLcg(9021);
  const b = makeLcg(9021);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
});

test('makeLcg values stay in [0, 1)', () => {
  const r = makeLcg(7);
  for (let i = 0; i < 1000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, 'out of range: ' + v);
  }
});

test('sampleOpenPositions returns exactly count unique-enough points outside the spawn square', () => {
  const pts = sampleOpenPositions(makeLcg(1), 50, 24, 7);
  assert.equal(pts.length, 50);
  for (const { x, z } of pts) {
    assert.ok(Math.abs(x) >= 7 || Math.abs(z) >= 7, 'point inside spawn square: ' + x + ',' + z);
    assert.ok(Math.abs(x) <= 24 && Math.abs(z) <= 24, 'point outside arena: ' + x + ',' + z);
  }
});

test('sampleOpenPositions is deterministic', () => {
  const a = sampleOpenPositions(makeLcg(42), 20, 24, 7);
  const b = sampleOpenPositions(makeLcg(42), 20, 24, 7);
  assert.deepEqual(a, b);
});

test('fitScale normalizes a model bbox to a target height', () => {
  // bbox 2m tall -> target 0.5m => scale 0.25
  assert.equal(fitScale({ minY: 0, maxY: 2 }, 0.5), 0.25);
  // degenerate bbox -> scale 1 (never divide by ~0)
  assert.equal(fitScale({ minY: 1, maxY: 1 }, 0.5), 1);
});

test('fitScale respects an optional max cap', () => {
  assert.equal(fitScale({ minY: 0, maxY: 10 }, 0.5, 0.04), 0.04);
});
