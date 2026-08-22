// Objective HUD (PRD-objective-hud.md, Cycle 23):
//   - DAILY/WEEKLY objective rows carry machine-readable {kind, value} targets
//     consistent with their predicates (AC1)
//   - objectiveProgress(targets, run) -> [{id, done}] deterministic, inclusive,
//     agreeing with the server-side evaluators (AC2)
// Run: node --test test/objectivesHud.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_OBJECTIVES, dailyObjectives, evaluateDailyRun,
} from '../src/shared/sim/dailyRun.js';
import {
  WEEKLY_OBJECTIVES, weeklyObjectives, evaluateWeeklyRun,
} from '../src/shared/sim/weeklyRun.js';
import { objectiveProgress } from '../src/shared/sim/objectivesHud.js';

for (const [name, table] of [['daily', DAILY_OBJECTIVES], ['weekly', WEEKLY_OBJECTIVES]]) {
  test(`${name} rows carry kind/value consistent with predicates (AC1)`, () => {
    assert.equal(table.length, 4);
    for (const o of table) {
      const m = o.id.match(/^(wave|score)_(\d+)$/);
      assert.ok(m, `${o.id} encodes kind_value`);
      assert.equal(o.kind, m[1]);
      assert.equal(o.value, Number(m[2]));
      assert.ok(o.value > 0);
    }
    // spot-check the predicate boundary equals the declared value
    const w = table.find((o) => o.kind === 'wave');
    const s = table.find((o) => o.kind === 'score');
    assert.equal(w.test({ wave: w.value - 1, score: 0 }), false);
    assert.equal(w.test({ wave: w.value, score: 0 }), true);
    assert.equal(s.test({ wave: 0, score: s.value - 1 }), false);
    assert.equal(s.test({ wave: 0, score: s.value }), true);
  });
}

test('objectiveProgress: inclusive boundaries + determinism (AC2)', () => {
  // Each pick is done exactly at its own boundary and unmet one step below,
  // regardless of which dimensions the day's picks span.
  const picks = [{ id: 'w', kind: 'wave', value: 5 }, { id: 's', kind: 'score', value: 500 }];
  assert.deepEqual(objectiveProgress(picks, { wave: 5, score: 500 }),
    [{ id: 'w', done: true }, { id: 's', done: true }]);
  assert.deepEqual(objectiveProgress(picks, { wave: 4, score: 499 }),
    [{ id: 'w', done: false }, { id: 's', done: false }]);
  assert.deepEqual(objectiveProgress([], { wave: 99, score: 99 }), []);
  assert.deepEqual(
    objectiveProgress([{ id: 'x', kind: 'wave', value: 3 }], { wave: 3, score: 0 }),
    objectiveProgress([{ id: 'x', kind: 'wave', value: 3 }], { wave: 3, score: 0 }));
});

test('objectiveProgress agrees with server-side evaluators across sampled days/weeks', () => {
  for (const day of ['2026-08-20', '2026-08-21', '2026-08-22']) {
    const picks = dailyObjectives(day).map(({ id, kind, value }) => ({ id, kind, value }));
    const run = { wave: 6, score: 700 };
    const mine = new Map(objectiveProgress(picks, run).map((r) => [r.id, r.done]));
    const theirs = new Map(evaluateDailyRun(dailyObjectives(day), run).map((r) => [r.id, r.done]));
    assert.deepEqual(mine, theirs, `day ${day} agreement`);
  }
  for (const week of ['2026-W33', '2026-W34']) {
    const picks = weeklyObjectives(week).map(({ id, kind, value }) => ({ id, kind, value }));
    const run = { wave: 9, score: 1500 };
    const mine = new Map(objectiveProgress(picks, run).map((r) => [r.id, r.done]));
    const theirs = new Map(evaluateWeeklyRun(weeklyObjectives(week), run).map((r) => [r.id, r.done]));
    assert.deepEqual(mine, theirs, `week ${week} agreement`);
  }
});
