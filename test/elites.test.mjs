import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ELITE_EVERY_N_WAVES, ELITE_AFFIXES,
  isEliteWave, affixForWave, affixByName, applyElite
} from '../src/shared/sim/elites.js';

test('isEliteWave: multiples of 5 only', () => {
  assert.equal(isEliteWave(5), true);
  assert.equal(isEliteWave(10), true);
  assert.equal(isEliteWave(50), true);
  assert.equal(isEliteWave(4), false);
  assert.equal(isEliteWave(6), false);
  assert.equal(isEliteWave(0), false);
  assert.equal(isEliteWave(-5), false);
  assert.equal(isEliteWave(5.5), false);
});

test('affixForWave: deterministic 4-cycle across elite waves', () => {
  const seq = [5, 10, 15, 20, 25, 30].map(affixForWave);
  assert.deepEqual(seq.slice(0, 4), ['Swift', 'Bulwark', 'Vampiric', 'Volatile']);
  assert.equal(seq[4], 'Swift', 'cycle repeats at wave 25');
  assert.equal(seq[5], 'Bulwark');
  for (const n of [1, 2, 3, 4, 7, 11]) {
    assert.equal(affixForWave(n), null, `wave ${n} has no affix`);
  }
});

test('affix table shape-valid and names round-trip', () => {
  assert.ok(ELITE_AFFIXES.length >= 4);
  for (const a of ELITE_AFFIXES) {
    assert.equal(typeof a.name, 'string');
    assert.ok(a.hpMul > 0);
    assert.ok(a.speedMul > 0);
    assert.equal(typeof a.knockbackImmune, 'boolean');
    assert.ok(a.vampiricPct >= 0 && a.vampiricPct <= 1);
    if (a.volatile) {
      assert.ok(a.volatile.radius > 0);
      assert.ok(a.volatile.damage > 0);
      assert.ok(a.volatile.fuseMs > 0);
    }
    assert.equal(affixByName(a.name), a, `${a.name} round-trips`);
  }
  // PRD headline numbers
  assert.equal(affixByName('Swift').speedMul, 1.6);
  assert.equal(affixByName('Bulwark').hpMul, 2.5);
  assert.equal(affixByName('Bulwark').knockbackImmune, true);
  assert.equal(affixByName('Vampiric').vampiricPct, 0.5);
  assert.deepEqual(affixByName('Volatile').volatile, { radius: 3, damage: 25, fuseMs: 800 });
  assert.equal(affixByName('Nope'), null);
});

test('applyElite scales hp from base max hp', () => {
  const e = { elite: '', hp: 100 };
  const a = applyElite(e, 'Bulwark', 40);
  assert.equal(e.elite, 'Bulwark');
  assert.equal(e.hp, Math.ceil(40 * 2.5));
  assert.equal(a.name, 'Bulwark');

  const e2 = { hp: 1 };
  applyElite(e2, 'Swift', 33);
  assert.equal(e2.elite, 'Swift');
  assert.equal(e2.hp, 33, 'hpMul 1.0 keeps base');

  const before = { elite: '', hp: 9 };
  assert.equal(applyElite(before, 'Ghost', 10), null, 'unknown affix no-ops');
  assert.equal(applyElite(null, 'Swift', 10), null);

  const normal = { elite: '', hp: 7 };
  const swift = applyElite(normal, 'Swift', 7);
  assert.equal(swift.name, 'Swift');
  assert.equal(normal.hp, 7);
});

test('affixForWave agrees with isEliteWave for a long range', () => {
  for (let n = 1; n <= 100; n++) {
    const a = affixForWave(n);
    if (isEliteWave(n)) {
      assert.ok(a && affixByName(a), `wave ${n} -> valid affix ${a}`);
    } else {
      assert.equal(a, null, `wave ${n} must be elite-free`);
    }
  }
});

// ---------------------------------------------------------------------------
// FINALE BOSS (PRD-wave-finale follow-up): 'Warlord' — a boss-tier affix that
// NEVER rolls in the regular rotation; it exists only for the finale wave so
// the run's last stand has a face.
// ---------------------------------------------------------------------------

import {
  finaleBossFor,
} from '../src/shared/sim/elites.js';

test('Warlord exists with boss-tier stats but is excluded from rotation', () => {
  const warlord = affixByName('Warlord');
  assert.ok(warlord, 'Warlord registered');
  assert.equal(warlord.hpMul, 3);
  assert.equal(warlord.knockbackImmune, true);
  assert.equal(warlord.vampiricPct, 0.25);
  // Rotation sweep: no regular elite wave ever hands out the boss.
  for (let n = 1; n <= 200; n++) {
    const a = affixForWave(n);
    assert.notEqual(a, 'Warlord', `rotation leaked Warlord at wave ${n}`);
  }
});

test('finaleBossFor: exact finale wave only', () => {
  assert.equal(finaleBossFor(12, 12), 'Warlord');
  assert.equal(finaleBossFor(11, 12), null);
  assert.equal(finaleBossFor(13, 12), null);
  assert.equal(finaleBossFor(10, 10), 'Warlord', 'supersedes a regular elite wave');
  assert.equal(finaleBossFor(12, 0), null, 'endless mode has no boss');
  assert.equal(finaleBossFor(12, undefined), null);
});
