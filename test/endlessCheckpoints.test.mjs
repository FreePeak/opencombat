// Offline progression checkpoints (PRD Step B): endless LocalRoom folds each
// cleared wave into the local career record via onCheckpoint + toasts fresh
// achievements once; legacy default rooms never fire either path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalRoom } from '../src/LocalRoom.js';

// Same headless harness as endlessLocal.test.mjs: join, stop the rAF loop,
// burn the countdown, then drive _step manually.
async function boot(room, name) {
  await room.join(name, 0);
  room._running = false;
  room._countdownTimer = 0;
  room._step(0.05);
  return room.state.players.get(room.sessionId);
}

/** Zero every enemy slot so the next 'playing' step sees alive === 0 and
 *  runs the wave-clear -> intermission transition under test. */
function clearWave(room) {
  room.state.enemies.forEach((e) => { e.hp = 0; });
  room._step(0.05);
}

/** Intermission -> next wave countdown -> playing (endless skips the finale). */
function advanceWave(room) {
  room.send('nextWave');
  room._countdownTimer = 0;
  room._step(0.05);
}

test('ENDLESS checkpoints: two clears fold bestWave 1 then 2; first_run toasts once', async () => {
  const room = new LocalRoom({ endless: true });
  const checkpoints = [];
  const emits = [];
  try {
    room.onCheckpoint = (rec) => checkpoints.push(rec);
    room.onMessage('achievementsUnlocked', (d) => emits.push(d.ids));
    const me = await boot(room, 'CheckpointT');

    // Wave 1 clear -> checkpoint {runs:1, bestWave:1}; first_run unlocks
    // (career.runs seeds at 1); wave_5/score_2k stay locked at these values.
    clearWave(room);
    assert.equal(room.state.matchState, 'intermission');
    assert.equal(checkpoints.length, 1, 'one checkpoint per cleared wave');
    assert.deepEqual(checkpoints[0], { runs: 1, bestWave: 1, bestScore: 0 });
    assert.equal(emits.length, 1, 'exactly one emit on the first checkpoint');
    assert.deepEqual(emits[0], ['first_run']);

    // Wave 2 with a score bump: bestScore folds up, no new predicates pass.
    advanceWave(room);
    assert.equal(room.state.wave, 2);
    me.score = 500;
    clearWave(room);
    assert.equal(room.state.matchState, 'intermission');
    assert.equal(checkpoints.length, 2);
    assert.deepEqual(checkpoints[1], { runs: 1, bestWave: 2, bestScore: 500 });
    assert.equal(emits.length, 1, 'second checkpoint stays silent below thresholds');
  } finally {
    try { room.leave(); } catch {}
  }
});

test('ENDLESS checkpoints: batched unlocks in stable table order across waves', async () => {
  const room = new LocalRoom({ endless: true });
  const checkpoints = [];
  const emits = [];
  try {
    room.onCheckpoint = (rec) => checkpoints.push(rec);
    room.onMessage('achievementsUnlocked', (d) => emits.push(d.ids));
    const me = await boot(room, 'BatchT');
    me.score = 3000; // endless: targetScore win check is disabled

    // Drive five full wave clears.
    for (let wave = 1; wave <= 5; wave++) {
      clearWave(room);
      if (wave < 5) advanceWave(room);
    }
    assert.equal(checkpoints.length, 5, 'exactly one checkpoint per cleared wave');
    assert.equal(checkpoints[4].bestWave, 5);
    assert.equal(checkpoints[4].bestScore, 3000);
    // Checkpoint 1 already satisfied first_run + score_2k together (stable
    // table order); wave_5 joins alone when bestWave crosses 5 on checkpoint 5.
    assert.equal(emits.length, 2);
    assert.deepEqual(emits[0], ['first_run', 'score_2k']);
    assert.deepEqual(emits[1], ['wave_5']);
  } finally {
    try { room.leave(); } catch {}
  }
});

test('LEGACY default unchanged: non-endless rooms never fire onCheckpoint', async () => {
  const room = new LocalRoom();
  const checkpoints = [];
  const emits = [];
  try {
    room.onCheckpoint = (rec) => checkpoints.push(rec);
    room.onMessage('achievementsUnlocked', (d) => emits.push(d.ids));
    await boot(room, 'LegacyC');

    // Really clear wave 1 so the guarded hook's surrounding path executes.
    clearWave(room);
    assert.equal(room.state.matchState, 'intermission',
      'clear->intermission transition itself still happens offline-legacy');
    assert.equal(checkpoints.length, 0, 'no checkpoint without endless mode');
    assert.equal(emits.length, 0, 'no checkpoint-path achievement broadcast');
  } finally {
    try { room.leave(); } catch {}
  }
});
