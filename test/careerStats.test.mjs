import { test } from 'node:test';
import assert from 'node:assert/strict';

// RED-first contract for src/shared/sim/careerStats.js (PRD-career-stats.md).
import { recordRun } from '../src/shared/sim/careerStats.js';

test('recordRun: fresh career from a victory run', () => {
  const c = recordRun(null, { wave: 7, score: 420, victory: true });
  assert.deepEqual(c, { runs: 1, victories: 1, bestWave: 7, bestScore: 420 });
});

test('recordRun: counters accumulate, maxes clamp monotonically', () => {
  let c = recordRun(null, { wave: 5, score: 100, victory: false });
  c = recordRun(c, { wave: 9, score: 250, victory: true });
  c = recordRun(c, { wave: 3, score: 90, victory: false }); // worse run
  assert.equal(c.runs, 3);
  assert.equal(c.victories, 1);
  assert.equal(c.bestWave, 9);
  assert.equal(c.bestScore, 250);
});

test('recordRun: ties keep counts but never regress maxes', () => {
  let c = recordRun(null, { wave: 8, score: 500, victory: false });
  c = recordRun(c, { wave: 8, score: 500, victory: false });
  assert.equal(c.runs, 2);
  assert.equal(c.bestWave, 8);
  assert.equal(c.bestScore, 500);
});

test('recordRun: unknown/NaN inputs are sanitized defensively', () => {
  const c = recordRun(null, { wave: NaN, score: undefined, victory: null });
  assert.equal(c.runs, 1);
  assert.equal(c.bestWave, 0);
  assert.equal(c.bestScore, 0);
  assert.equal(c.victories, 0);
});

// ---------------------------------------------------------------------------
// Unlock tiers (PRD-career-stats.md tier addendum): bestWave thresholds map
// to cosmetic tiers. Pure derivation — pinned here so rooms + client agree.
// ---------------------------------------------------------------------------
import { tierForCareer } from '../src/shared/sim/careerStats.js';

test('tierForCareer: 6/9/12 bestWave thresholds', () => {
  assert.equal(tierForCareer({ bestWave: 0 }), 0);
  assert.equal(tierForCareer({ bestWave: 5 }), 0);
  assert.equal(tierForCareer({ bestWave: 6 }), 1);
  assert.equal(tierForCareer({ bestWave: 8 }), 1);
  assert.equal(tierForCareer({ bestWave: 9 }), 2);
  assert.equal(tierForCareer({ bestWave: 11 }), 2);
  assert.equal(tierForCareer({ bestWave: 12 }), 3);
  assert.equal(tierForCareer({ bestWave: 99 }), 3);
  assert.equal(tierForCareer(null), 0);
  assert.equal(tierForCareer(undefined), 0);
});
