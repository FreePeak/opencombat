import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STREAK_WINDOW_MS, MILESTONES,
  newStreakState, milestoneFor, registerKill, resetSid, resetAll
} from '../src/shared/sim/streaks.js';

test('window + milestone table shape', () => {
  assert.equal(STREAK_WINDOW_MS, 2500);
  assert.deepEqual(MILESTONES.map(m => m.count), [3, 5, 10, 15, 25]);
  assert.equal(milestoneFor(3), 'Killing Spree');
  assert.equal(milestoneFor(5), 'Rampage');
  assert.equal(milestoneFor(10), 'Dominating');
  assert.equal(milestoneFor(15), 'Unstoppable');
  assert.equal(milestoneFor(25), 'Godlike');
  for (const n of [1, 2, 4, 6, 9, 11, 24, 26]) {
    assert.equal(milestoneFor(n), null, `count ${n} is silent`);
  }
});

test('registerKill: fast sequence announces only at milestones', () => {
  const s = newStreakState();
  const t0 = 100000;
  const out = [];
  for (let i = 1; i <= 5; i++) {
    out.push(registerKill(s, 'p1', t0 + i * 500)); // 500ms apart, inside window
  }
  assert.deepEqual(out, [null, null, 'Killing Spree', null, 'Rampage']);
});

test('registerKill: window lapse silently restarts at 1', () => {
  const s = newStreakState();
  const t0 = 100000;
  assert.equal(registerKill(s, 'p1', t0), null);        // count 1
  assert.equal(registerKill(s, 'p1', t0 + STREAK_WINDOW_MS + 1), null); // reset to 1
  const entry = s.get('p1');
  assert.equal(entry.count, 1);
  assert.equal(entry.lastAt, t0 + STREAK_WINDOW_MS + 1);
});

test('registerKill: exact window boundary still counts as continuation', () => {
  const s = newStreakState();
  const t0 = 100000;
  registerKill(s, 'p1', t0);
  registerKill(s, 'p1', t0 + STREAK_WINDOW_MS - 1);
  assert.equal(s.get('p1').count, 2);
});

test('registerKill: players tracked independently', () => {
  const s = newStreakState();
  assert.equal(registerKill(s, 'a', 1000), null);
  assert.equal(registerKill(s, 'b', 1100), null);
  assert.equal(registerKill(s, 'a', 1500), null);
  assert.equal(registerKill(s, 'b', 1600), null);
  assert.equal(registerKill(s, 'a', 2000), 'Killing Spree');
  assert.equal(s.get('a').count, 3);
  assert.equal(s.get('b').count, 2);
});

test('resetSid / resetAll drop streaks', () => {
  const s = newStreakState();
  registerKill(s, 'p1', 1000);
  registerKill(s, 'p2', 1100);
  resetSid(s, 'p1');
  assert.equal(s.has('p1'), false);
  assert.equal(s.get('p2').count, 1);
  resetAll(s);
  assert.equal(s.size, 0);
});
