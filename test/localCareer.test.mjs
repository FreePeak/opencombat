import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_CAREER_KEY, loadLocalCareer, saveLocalCareer, checkpointWave
} from '../src/shared/sim/localCareer.js';

function stubStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  };
}

test('save/load round-trip', () => {
  const s = stubStorage();
  const rec = { runs: 1, bestWave: 7, bestScore: 1234 };
  saveLocalCareer(s, rec);
  assert.deepEqual(loadLocalCareer(s), rec);
  assert.equal(s._map.get(LOCAL_CAREER_KEY), JSON.stringify(rec));
});

test('corrupt/absent storage degrades gracefully', () => {
  assert.equal(loadLocalCareer(stubStorage()), null);
  assert.equal(loadLocalCareer(undefined), null);
  const broken = stubStorage({ [LOCAL_CAREER_KEY]: '{not json' });
  assert.equal(loadLocalCareer(broken), null);
  const junk = stubStorage({ [LOCAL_CAREER_KEY]: '42' });
  assert.equal(loadLocalCareer(junk), null, 'non-object JSON resets to null');
});

test('checkpoint monotonic: maxes only, input untouched', () => {
  const prev = { runs: 1, bestWave: 5, bestScore: 900 };
  const next = checkpointWave(prev, { wave: 3, score: 1500 });
  assert.deepEqual(next, { runs: 1, bestWave: 5, bestScore: 1500 });
  assert.deepEqual(prev, { runs: 1, bestWave: 5, bestScore: 900 }, 'input not mutated');
  const up = checkpointWave(next, { wave: 8, score: 400 });
  assert.deepEqual(up, { runs: 1, bestWave: 8, bestScore: 1500 });
});

test('first checkpoint seeds runs=1 from null', () => {
  assert.deepEqual(checkpointWave(null, { wave: 1, score: 40 }),
    { runs: 1, bestWave: 1, bestScore: 40 });
});
