import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalRoom } from '../src/LocalRoom.js';
import { SERVER } from '../src/server/config.js';

function boot(room, name) {
  return (async () => {
    await room.join(name, 0);
    room._running = false;
    room._countdownTimer = 0;
    room._step(0.05);
    return room.state.players.get(room.sessionId);
  })();
}

test('ENDLESS: offline local play never ends on targetScore', async () => {
  const room = new LocalRoom({ endless: true });
  try {
    const me = await boot(room, 'EndlessT');
    me.score = SERVER.match.targetScore;
    room._step(0.05);
    assert.equal(room.state.matchState, 'playing', 'score win disabled in endless mode');
    assert.equal(room._matchEnded, false);
  } finally {
    try { room.leave(); } catch {}
  }
});

test('ENDLESS: advancing past finaleWave keeps spawning waves (no victory arc)', async () => {
  const prev = SERVER.wave.finaleWave;
  SERVER.wave.finaleWave = 1;
  const room = new LocalRoom({ endless: true });
  try {
    await boot(room, 'EndlessF');
    room.state.wave = 1;
    room.state.matchState = 'intermission';
    room.send('nextWave');
    room._step(0.05);
    assert.equal(room.state.wave, 2, 'wave 13+ spawns past the old finale');
    assert.equal(room.state.matchState, 'countdown');
    assert.notEqual(room.state.matchState, 'gameover');
    assert.equal(room.state.victory, false);
  } finally {
    try { room.leave(); } catch {}
    SERVER.wave.finaleWave = prev;
  }
});

test('LEGACY default unchanged: score still ends non-flagged local runs', async () => {
  const room = new LocalRoom();
  try {
    const me = await boot(room, 'LegacyT');
    me.score = SERVER.match.targetScore;
    room._step(0.05);
    assert.equal(room.state.matchState, 'gameover', 'legacy semantics preserved');
  } finally {
    try { room.leave(); } catch {}
  }
});
