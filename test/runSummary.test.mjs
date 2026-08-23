// Run summary polish (FR-RET-03): kills reset on replay + time-survived
// formatting for the gameover/share surfaces.
// Run: node --test test/runSummary.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorldState, PlayerState } from '../src/server/schema/StateSchema.js';
import { resetMatchState } from '../src/shared/sim/matchPhases.js';
import { buildShareCard, shareText, formatRunTime } from '../src/shared/sim/shareCard.js';

test('kills reset to 0 on replay (FR-GAME-03 follow-up)', () => {
  const state = new WorldState();
  const p = new PlayerState(0, 0);
  p.kills = 42;
  p.score = 500;
  state.players.set('sid-1', p);
  resetMatchState(
    {
      state,
      pendingUntil: new Map(),
      spawnWave: () => {},
    },
    {
      samplePos: () => ({ x: 0, z: 0 }),
    },
  );
  assert.equal(p.kills, 0, 'kills must not carry across matches');
  assert.equal(p.score, 0);
});

test('formatRunTime renders M:SS and clamps junk', () => {
  assert.equal(formatRunTime(0), '0:00');
  assert.equal(formatRunTime(65), '1:05');
  assert.equal(formatRunTime(600), '10:00');
  assert.equal(formatRunTime(3599), '59:59');
  assert.equal(formatRunTime(-5), '0:00');
  assert.equal(formatRunTime(NaN), '0:00');
});

test('share card carries Time only when provided; value formatted', () => {
  const withTime = buildShareCard({ mode: 'waves', wave: 3, score: 100, timeSec: 125 });
  const row = withTime.stats.find((s) => s.label === 'Time');
  assert.ok(row, 'time row present');
  assert.equal(row.value, '2:05');
  const without = buildShareCard({ mode: 'waves', wave: 3, score: 100 });
  assert.ok(!without.stats.some((s) => s.label === 'Time'));
  assert.equal(shareText(withTime).split('2:05').length - 1, 1);
});
