import { test } from 'node:test';
import assert from 'node:assert/strict';

// RED-first contract for src/shared/sim/magnetPull.js (PRD-magnet.md).
// Pure module — no imports — mirroring orbDrops/elites/archetypes so both
// sims and these tests share ONE source of truth.

import { pullOrbs } from '../src/shared/sim/magnetPull.js';

test('pullOrbs: pulls an in-radius orb toward the holder, clamped to contact', () => {
  const orb = { x: 5, z: 0 };
  const holder = { x: 0, z: 0 };
  // speed 10 * dt 1 = 10 units requested, but distance is only 5 -> lands ON holder.
  const moved = pullOrbs([orb], [holder], 8, 10, 1);
  assert.equal(moved, 1);
  assert.equal(orb.x, 0);
  assert.equal(orb.z, 0);
});

test('pullOrbs: partial pull respects speed*dt and direction', () => {
  const orb = { x: 5, z: 0 };
  const holder = { x: 0, z: 0 };
  pullOrbs([orb], [holder], 8, 10, 0.1); // 1 unit this tick
  assert.ok(Math.abs(orb.x - 4) < 1e-9, `moved 1 toward holder, got ${orb.x}`);
  assert.equal(orb.z, 0);
});

test('pullOrbs: orbs beyond radius never move', () => {
  const orb = { x: 20, z: 0 };
  const holder = { x: 0, z: 0 };
  assert.equal(pullOrbs([orb], [holder], 8, 10, 0.1), 0);
  assert.equal(orb.x, 20);
});

test('pullOrbs: first holder in insertion order wins per orb per tick', () => {
  const orb = { x: 5, z: 0 };
  const h1 = { x: 0, z: 0 };   // in range
  const h2 = { x: 100, z: 0 }; // also "in range" of nothing; far
  pullOrbs([orb], [h1, h2], 8, 2.5, 0.4); // 1 unit toward h1
  assert.ok(Math.abs(orb.x - 4) < 1e-9);
  // Both in range: earlier holder wins.
  const orb2 = { x: 5, z: 0 };
  const near1 = { x: 4, z: 0 };
  const near2 = { x: 6, z: 0 };
  pullOrbs([orb2], [near1, near2], 8, 10, 0.1);
  assert.ok(Math.abs(orb2.x - (5 - 1)) < 1e-9 || Math.abs(orb2.x) < 1e-9,
    'drifted toward the FIRST holder');
});

test('pullOrbs: no holders / dead-weight inputs are safe no-ops', () => {
  const orb = { x: 3, z: 3 };
  assert.equal(pullOrbs([orb], [], 8, 10, 0.1), 0);
  assert.equal(pullOrbs([], [{ x: 0, z: 0 }], 8, 10, 0.1), 0);
  assert.equal(orb.x, 3);
});
