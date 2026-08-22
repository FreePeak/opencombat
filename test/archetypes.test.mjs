import { test } from 'node:test';
import assert from 'node:assert/strict';

// RED-first contract for src/shared/sim/archetypes.js (PRD-enemy-archetypes.md).
// The module must be pure (no imports) so GameRoom, LocalRoom and these tests
// share ONE source of truth, mirroring the elites.js contract.

const SERVER_ENEMY_CONTACT = () => 1.3; // contactRange sanity anchor

import {
  ARCHETYPES,
  ARCHETYPE_FROM_WAVE,
  SHOOTER_FROM_WAVE,
  SHOOTER_PREFERRED_RANGE,
  SHOOTER_FIRE_COOLDOWN_MS,
  archetypeForSlot,
  archetypeByName,
  markArchetypes,
} from '../src/shared/sim/archetypes.js';

test('ARCHETYPES table shape: PRD stat deltas', () => {
  assert.ok(Array.isArray(ARCHETYPES) && ARCHETYPES.length === 3);
  const shooter = ARCHETYPES.find((a) => a.name === 'Shooter');
  assert.ok(shooter, 'shooter archetype exists');
  assert.equal(shooter.hpMul, 1.0);
  assert.equal(shooter.speedMul, 0.85);
  assert.equal(SHOOTER_FROM_WAVE, 5);
  assert.ok(SHOOTER_PREFERRED_RANGE > SERVER_ENEMY_CONTACT());
  assert.ok(SHOOTER_FIRE_COOLDOWN_MS >= 2000);
  const byName = Object.fromEntries(ARCHETYPES.map((a) => [a.name, a]));
  assert.equal(byName.Rusher.hpMul, 0.75);
  assert.equal(byName.Rusher.speedMul, 1.4);
  assert.equal(byName.Tank.hpMul, 2.0);
  assert.equal(byName.Tank.speedMul, 0.7);
  assert.equal(byName.Tank.knockbackMul, 0.25);
  for (const a of ARCHETYPES) {
    assert.equal(typeof a.name, 'string');
    assert.equal(typeof a.hpMul, 'number');
    assert.equal(typeof a.speedMul, 'number');
    assert.equal(typeof a.knockbackMul, 'number');
  }
});

test('archetypeForSlot: waves 1-2 stay pure chasers', () => {
  for (let w = -2; w <= 2; w++) {
    for (let s = 0; s < 10; s++) {
      assert.equal(archetypeForSlot(w, s), '', `wave ${w} slot ${s}`);
    }
  }
});

test('archetypeForSlot: deterministic pattern from wave 3', () => {
  // Wave 3, slots 0..4 live: '' , '', Rusher, Rusher, Tank
  assert.equal(archetypeForSlot(3, 0), '');
  assert.equal(archetypeForSlot(3, 1), '');
  assert.equal(archetypeForSlot(3, 2), 'Rusher');
  assert.equal(archetypeForSlot(3, 3), 'Rusher');
  assert.equal(archetypeForSlot(3, 4), 'Tank');
  // Same inputs always agree (parity depends on this)
  for (let w = 3; w <= 60; w++) {
    for (let s = 0; s < 12; s++) {
      const a = archetypeForSlot(w, s);
      assert.equal(a, archetypeForSlot(w, s));
      const allowed = w >= SHOOTER_FROM_WAVE
        ? ['', 'Rusher', 'Tank', 'Shooter']
        : ['', 'Rusher', 'Tank'];
      assert.ok(allowed.includes(a));
    }
  }
});

test('archetypeByName: lookup + unknown-safe no-op', () => {
  assert.equal(archetypeByName('Rusher').speedMul, 1.4);
  assert.equal(archetypeByName('Tank').knockbackMul, 0.25);
  assert.equal(archetypeByName(''), null);
  assert.equal(archetypeByName(undefined), null);
  assert.equal(archetypeByName('Volatile'), null); // elite affixes are not archetypes
});

test('markArchetypes: stamps tags + scales hp on live slots only', () => {
  const enemies = Array.from({ length: 6 }, (_, i) => ({ hp: i < 5 ? 4 : 0, archetype: '' }));
  const marked = markArchetypes(enemies, 3, { liveCount: 5 });
  assert.equal(marked, 3); // slots 2,3 rusher + slot 4 tank
  assert.equal(enemies[2].archetype, 'Rusher');
  assert.equal(enemies[2].hp, Math.ceil(4 * 0.75));
  assert.equal(enemies[4].archetype, 'Tank');
  assert.equal(enemies[4].hp, 8);
  assert.equal(enemies[0].archetype, '');
  assert.equal(enemies[5].archetype, ''); // dead slot untouched
});

test('markArchetypes: waves below threshold are a no-op', () => {
  const enemies = [{ hp: 4, archetype: '' }, { hp: 4, archetype: '' }];
  assert.equal(markArchetypes(enemies, 2), 0);
  assert.equal(enemies[0].archetype, '');
  assert.equal(enemies[0].hp, 4);
});

test('markArchetypes: elite slot 0 is skipped so the spike stays readable', () => {
  const enemies = [
    { hp: 20, archetype: '', elite: 'Swift' },
    { hp: 4, archetype: '' },
    { hp: 4, archetype: '' },
    { hp: 4, archetype: '' },
    { hp: 4, archetype: '' },
  ];
  const marked = markArchetypes(enemies, 5, { liveCount: 5, eliteWave: true });
  assert.equal(enemies[0].archetype, '');
  assert.equal(enemies[0].hp, 20); // applyElite already stamped; we never touch it
  // wave 5 non-elite slots: (5+s)%5 -> s=1..4 all k=... rusher/rusher? verify via selector
  const expected = [1, 2, 3, 4].map((s) => archetypeForSlot(5, s));
  assert.equal(marked, expected.filter(Boolean).length);
  assert.equal(enemies[1].archetype, expected[0]);
  assert.equal(enemies[4].archetype, expected[3]);
});

test('markArchetypes: resets stale tags when re-marking a revived pool', () => {
  const enemies = [
    { hp: 4, archetype: 'Tank' },
    { hp: 4, archetype: 'Rusher' },
    { hp: 4, archetype: '' },
  ];
  // Wave 3 marks slot 2 as Rusher and CLEARS slots that resolve to ''.
  markArchetypes(enemies, 3, { liveCount: 3 });
  assert.equal(enemies[0].archetype, '');
  assert.equal(enemies[1].archetype, '');
  assert.equal(enemies[2].archetype, 'Rusher');
});

test('archetypeForSlot: shooters appear from wave 5 at k===3', () => {
  // waves below SHOOTER_FROM_WAVE never roll shooters even when k===3.
  assert.equal(archetypeForSlot(3, 0), '');   // k=3 but wave 3
  assert.equal(archetypeForSlot(4, 4), '');   // k=3 but wave 4
  // From wave 5: (w+s)%5===3 -> Shooter.
  let seen = false;
  for (let w = SHOOTER_FROM_WAVE; w <= 40; w++) {
    for (let sl = 0; sl < 10; sl++) {
      if ((w + sl) % 5 === 3) {
        assert.equal(archetypeForSlot(w, sl), 'Shooter', `w${w} s${sl}`);
        seen = true;
      }
    }
  }
  assert.ok(seen, 'selector actually produces shooters');
});

test('markArchetypes: shooter charges carry hpMul 1.0 (no hp inflation)', () => {
  const enemies = Array.from({ length: 6 }, () => ({ hp: 4, archetype: '' }));
  // Force a layout where some slot resolves to Shooter at wave 5.
  markArchetypes(enemies, 7, { liveCount: 6 }); // (7+1)%5=3 -> slot1 Shooter
  assert.equal(enemies[1].archetype, 'Shooter');
  assert.equal(enemies[1].hp, 4, 'shooter hp unchanged');
});
