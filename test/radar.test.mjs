// Combat Radar (PRD-combat-radar.md, Cycle 19):
//   - projectRadar maps world positions to canvas-normalized [0,1] coords
//     relative to a self-centered radar
//   - self projects to exact center; axis-aligned span edges map to 0/1
//   - points beyond the visible span clamp to the rim with clamped: true
//   - pure + deterministic; no DOM, no imports
// Run: node --test test/radar.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectRadar } from '../src/shared/sim/radar.js';

const HALF = 30; // SERVER.world.size / 2

test('a point at the self position projects to exact center (AC1)', () => {
  const out = projectRadar([{ x: 12, z: -7, kind: 'ally' }], { x: 12, z: -7 }, HALF);
  assert.deepEqual([out[0].u, out[0].v], [0.5, 0.5]);
});

test('axis span math: half-unit offsets map to edges (AC2)', () => {
  const out = projectRadar([
    { x: HALF / 2, z: 0, kind: 'enemy' },   // exactly +half east of self at origin? no:
  ], { x: 0, z: 0 }, HALF / 2);
  assert.equal(out[0].u, 1);
  assert.equal(out[0].v, 0.5);
  assert.equal(out[0].clamped, false);
});

test('corner projection is exact', () => {
  const out = projectRadar([
    { x: -15, z: -15, kind: 'ally' },
    { x: 5, z: 10, kind: 'enemy' },
  ], { x: 0, z: 0 }, 30);
  assert.deepEqual([out[0].u, out[0].v], [0.25, 0.25]);
  assert.deepEqual([out[1].u, out[1].v], [0.5833333333333334, 0.6666666666666666]);
});

test('beyond-span blips clamp to rim with clamped:true (AC2)', () => {
  const out = projectRadar([
    { x: 100, z: 3, kind: 'enemy' },   // far east
    { x: -100, z: -100, kind: 'enemy' }, // far NW corner
  ], { x: 0, z: 0 }, HALF);
  assert.equal(out[0].clamped, true);
  assert.equal(out[0].u, 1);
  assert.ok(out[0].v > 0 && out[0].v < 1);
  assert.equal(out[1].clamped, true);
  assert.equal(out[1].u, 0);
  assert.equal(out[1].v, 0);
});

test('empty input -> empty output; deterministic across calls', () => {
  assert.deepEqual(projectRadar([], { x: 3, z: 4 }, HALF), []);
  const a = projectRadar([{ x: 9, z: 9, kind: 'enemy' }], { x: 0, z: 0 }, HALF);
  const b = projectRadar([{ x: 9, z: 9, kind: 'enemy' }], { x: 0, z: 0 }, HALF);
  assert.deepEqual(a, b);
});
