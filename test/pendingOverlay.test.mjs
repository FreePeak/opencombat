import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// PRD-career-stats.md correctness pin: loadPlayer must see QUEUED (debounced)
// saves — two back-to-back read-merge-save cycles in one tick must not
// clobber each other's keys.
import {
  loadPlayer, savePlayerDebounced, flushAll, _dirForTests,
} from '../src/server/persistence.js';

const NAME = 'zz-overlay-pin';
const file = () => path.join(_dirForTests(), `${NAME}.json`);
const cleanup = () => { try { fs.unlinkSync(file()); } catch {} };

test('pendingOverlay: queued save is visible to loadPlayer before flush', () => {
  cleanup();
  assert.equal(loadPlayer(NAME), null);
  savePlayerDebounced(NAME, { career: { runs: 1 } });
  const seen = loadPlayer(NAME);
  assert.deepEqual(seen.career, { runs: 1 }, 'pending snapshot overlays');
});

test('pendingOverlay: second merge preserves the first unflushed key', () => {
  savePlayerDebounced(NAME, { career: { runs: 2 } });      // cycle 1 queue
  const loaded = loadPlayer(NAME);                          // sees career
  savePlayerDebounced(NAME, { ...loaded, daily: { streak: 3 } }); // cycle 2
  const merged = loadPlayer(NAME);
  assert.equal(merged.career.runs, 2, 'career survived the daily merge');
  assert.equal(merged.daily.streak, 3);
  flushAll();
  const onDisk = JSON.parse(fs.readFileSync(file(), 'utf8'));
  assert.equal(onDisk.career.runs, 2);
  assert.equal(onDisk.daily.streak, 3);
  cleanup();
});
