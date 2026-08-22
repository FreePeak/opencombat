import { test } from 'node:test';
import assert from 'node:assert/strict';

// RED-first contract for src/shared/sim/orbDrops.js (PRD-orb-drops.md).
// Pure module — no imports — mirroring elites.js/archetypes.js so GameRoom,
// LocalRoom and these tests share ONE source of truth. The rooms keep a
// Map keyed by schema orb objects (same idiom as powerUpTimers); this module
// only does math over [orbs, charges].

import {
  chargeForKill,
  drainCharge,
  clearCharges,
} from '../src/shared/sim/orbDrops.js';

const makeOrbs = (spots) => spots.map(([x, z]) => ({ x, z }));

test('chargeForKill: nearest uncharged orb teleports to the corpse', () => {
  const orbs = makeOrbs([[0, 0], [10, 0], [5, 0]]);
  const charges = new Map();
  const ok = chargeForKill(orbs, charges, 4, 0, 30);
  assert.equal(ok, true);
  assert.equal(charges.size, 1);
  const [orb, amount] = [...charges.entries()][0];
  assert.equal(orb, orbs[2], 'nearest uncharged wins (dist 1 vs 4 vs 6)');
  assert.equal(amount, 30);
  assert.equal(orb.x, 4);
  assert.equal(orb.z, 0, 'orb teleports to the corpse');
});

test('chargeForKill: index order breaks distance ties deterministically', () => {
  const orbs = makeOrbs([[5, 0], [5, 0]]);
  const charges = new Map();
  chargeForKill(orbs, charges, 0, 0, 30);
  assert.ok(charges.has(orbs[0]), 'first index wins ties');
});

test('chargeForKill: charged orbs are skipped', () => {
  const orbs = makeOrbs([[1, 0], [20, 0]]);
  const charges = new Map();
  charges.set(orbs[0], 10); // already charged (nearby)
  const ok = chargeForKill(orbs, charges, 0, 0, 30);
  assert.equal(ok, true);
  assert.ok(charges.has(orbs[1]), 'fallback to the far uncharged orb');
  assert.equal(charges.get(orbs[1]), 30);
  assert.equal(charges.get(orbs[0]), 10, 'existing charge untouched');
});

test('chargeForKill: all charged -> false, nothing mutates', () => {
  const orbs = makeOrbs([[0, 0], [9, 9]]);
  const charges = new Map();
  charges.set(orbs[0], 5).set(orbs[1], 6);
  const before = orbs.map((o) => `${o.x},${o.z}`).join('|');
  assert.equal(chargeForKill(orbs, charges, 3, 3, 30), false);
  assert.equal(charges.size, 2);
  assert.equal(orbs.map((o) => `${o.x},${o.z}`).join('|'), before);
});

test('drainCharge: pays once and reverts the orb to uncharged', () => {
  const orb = { x: 1, z: 1 };
  const charges = new Map();
  charges.set(orb, 60);
  assert.equal(drainCharge(charges, orb), 60);
  assert.equal(drainCharge(charges, orb), 0, 'second drain is a no-op');
  assert.equal(charges.has(orb), false);
});

test('clearCharges: reset path empties everything', () => {
  const charges = new Map();
  charges.set({ x: 0, z: 0 }, 30).set({ x: 1, z: 1 }, 60);
  clearCharges(charges);
  assert.equal(charges.size, 0);
});

test('chargeForKill/drainCharge mirror the charge onto the orb object', () => {
  const orbs = makeOrbs([[2, 0]]);
  const charges = new Map();
  chargeForKill(orbs, charges, 4, 4, 30);
  assert.equal(orbs[0].charge, 30, 'charged orb exposes its value for rendering');
  assert.equal(drainCharge(charges, orbs[0]), 30);
  assert.equal(orbs[0].charge, 0, 'drain reverts the exposed value');
});
