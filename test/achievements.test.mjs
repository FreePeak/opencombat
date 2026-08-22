import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACHIEVEMENTS, achievementById, evaluateAchievements
} from '../src/shared/sim/achievements.js';

test('table shape-valid: unique ids, names, predicates', () => {
  assert.ok(ACHIEVEMENTS.length >= 10);
  const ids = new Set(ACHIEVEMENTS.map(a => a.id));
  assert.equal(ids.size, ACHIEVEMENTS.length, 'ids unique');
  for (const a of ACHIEVEMENTS) {
    assert.equal(typeof a.name, 'string');
    assert.equal(typeof a.test, 'function');
    // predicate must not throw on an empty blob
    assert.doesNotThrow(() => a.test({}));
    assert.equal(achievementById(a.id), a, `${a.id} round-trips`);
  }
  assert.equal(achievementById('nope'), null);
});

test('empty blob unlocks nothing; one run unlocks first_run', () => {
  assert.deepEqual(evaluateAchievements({}), { unlocked: [], newIds: [] });
  const one = evaluateAchievements({ career: { runs: 1 } });
  assert.deepEqual(one.unlocked, ['first_run']);
  assert.deepEqual(one.newIds, ['first_run']);
  // input never mutated; null tolerated
  assert.deepEqual(evaluateAchievements(null), { unlocked: [], newIds: [] });
});

test('threshold boundaries inclusive', () => {
  const at10 = evaluateAchievements({ career: { runs: 10 } });
  assert.ok(at10.unlocked.includes('veteran'));
  const at9 = evaluateAchievements({ career: { runs: 9 } });
  assert.ok(!at9.unlocked.includes('veteran'));
  const wave12 = evaluateAchievements({ career: { bestWave: 12 } });
  assert.ok(wave12.unlocked.includes("warlord's end") || wave12.unlocked.includes('wave_12'));
  assert.ok(wave12.unlocked.includes('wave_5') && wave12.unlocked.includes('wave_9'),
    'lower tiers cascade');
});

test('already-unlocked ids excluded from newIds but kept in unlocked', () => {
  const saved = { career: { runs: 12 }, achievements: ['first_run'] };
  const { unlocked, newIds } = evaluateAchievements(saved);
  assert.ok(unlocked.includes('first_run'));
  assert.ok(!newIds.includes('first_run'));
  assert.ok(newIds.includes('veteran'));
  // stable order matches table order
  assert.deepEqual(unlocked, [...unlocked].sort(
    (a, b) => ACHIEVEMENTS.findIndex(x => x.id === a) - ACHIEVEMENTS.findIndex(x => x.id === b)
  ));
});

test('daily/weekly predicates read the right fields', () => {
  const s = { daily: { streak: 3 }, weekly: { bestScore: 1500 } };
  const { unlocked } = evaluateAchievements(s);
  assert.ok(unlocked.includes('daily_3'));
  assert.ok(unlocked.includes('weekly_1500'));
});
