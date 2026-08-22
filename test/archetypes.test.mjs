import { test } from 'node:test';
import assert from 'node:assert/strict';

// RED-first contract for src/shared/sim/archetypes.js (PRD-enemy-archetypes.md).
// The module must be pure (no imports) so GameRoom, LocalRoom and these tests
// share ONE source of truth, mirroring the elites.js contract.

import {
  ARCHETYPES,
  ARCHETYPE_FROM_WAVE,
  archetypeForSlot,
  archetypeByName,
  markArchetypes,
} from '../src/shared/sim/archetypes.js';

test('ARCHETYPES table shape: PRD stat deltas', () => {
  assert.ok(Array.isArray(ARCHETYPES) && ARCHETYPES.length === 2);
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
      assert.ok(['', 'Rusher', 'Tank'].includes(a));
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
