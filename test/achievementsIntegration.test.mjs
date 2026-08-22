// Achievements integration (PRD-achievements.md, Step B — rooms wiring):
//   - real Server on port 0; join 'game'
//   - a forced gameover whose career merge yields runs=1 + bestWave>=5
//     unlocks first_run AND wave_5 in EXACTLY ONE 'achievementsUnlocked'
//     broadcast (achievements see THIS run's merged values)
//   - data/players/<Name>.json persists the achievements array with both ids
//   - a second identical finalize emits NO duplicate unlock message
// Run: node --test test/achievementsIntegration.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import { flushAll, _dirForTests } from '../src/server/persistence.js';
import { LocalRoom } from '../src/LocalRoom.js';

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, timeoutMs = 10000, label = 'condition') => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await waitMs(30);
  }
  throw new Error('timeout waiting for ' + label);
};

SERVER.rateLimit.capacity = 10000;
const httpServer = http.createServer();
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app)
});
gameServer.define('game', GameRoom);
await gameServer.listen(0);
const port = httpServer.address().port;

const roomOf = (r) => [...GameRoom.instances].find((x) => x.roomId === r.roomId);
const NAME = 'AchvHero';
const playerFile = path.join(_dirForTests(), `${NAME}.json`);
const rmPlayerFile = () => { try { fs.rmSync(playerFile); } catch {} };

// ============================================================================
// ONLINE: one forced gameover -> ONE unlock batch (first_run + wave_5),
// persisted to the player file, silent on re-finalize.
// ============================================================================
{
  rmPlayerFile();
  // Pre-seed the persisted blob (waves.test TierPin idiom): a recorded
  // bestWave of 5 with zero runs means endMatch's FIRST career merge yields
  // runs=1 AND bestWave>=5 — both predicates flip in the same finalize.
  fs.writeFileSync(playerFile, JSON.stringify({
    career: { runs: 0, victories: 0, bestWave: 5, bestScore: 0 },
  }));

  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('game', { name: NAME }, WorldState);
  await waitFor(() => r.state?.matchState === 'playing', 8000, 'match playing');
  const sr = roomOf(r);

  const msgs = [];
  r.onMessage('achievementsUnlocked', (d) => msgs.push(d));

  // Force the ending through the normal win path: target-score gameover ->
  // endMatch records THIS run (victory) into the career merge, then the
  // achievement hook evaluates the JUST-MERGED record.
  const me = sr.state.players.get(r.sessionId);
  me.score = SERVER.match.targetScore;
  await waitFor(() => sr.state.matchState === 'gameover', 3000, 'forced win ends the match');
  await waitFor(() => msgs.length >= 1, 3000, 'achievementsUnlocked broadcast');
  await waitMs(300); // settle: any straggler would have arrived by now

  assert.equal(msgs.length, 1, 'exactly ONE achievementsUnlocked per unlock batch');
  const ids = msgs[0].ids;
  assert.ok(Array.isArray(ids), 'payload carries an ids array');
  assert.ok(ids.includes('first_run'), 'first_run unlocked (career.runs >= 1)');
  assert.ok(ids.includes('wave_5'), 'wave_5 unlocked (THIS run merged bestWave >= 5)');
  assert.ok(!ids.includes('veteran'), 'below-threshold ids stay locked');

  // The persisted file carries the full unlocked list (debounce flushed).
  flushAll();
  const saved = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
  assert.equal(saved.career.runs, 1, 'file: this run recorded once');
  assert.ok(saved.career.bestWave >= 5, 'file: bestWave >= 5');
  for (const id of ['first_run', 'wave_5']) {
    assert.ok(Array.isArray(saved.achievements) && saved.achievements.includes(id),
      `file: achievements[] contains ${id}`);
  }

  // SECOND identical finalize (drive internals like existing tests): every
  // predicate is already persisted -> newIds empty -> NO duplicate toast.
  sr.endMatch(sr.state.winnerId || r.sessionId);
  await waitMs(300);
  assert.equal(msgs.length, 1, 're-finalize never re-toasts');

  // Cleanup
  rmPlayerFile();
  r.leave();
}

await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();

// ============================================================================
// LOCAL PARITY: the offline sim mirrors the hook over its session career and
// emits the same payload shape on the local message channel — once per batch,
// silent across a playAgain replay that unlocks nothing new.
// ============================================================================
{
  const room = new LocalRoom();
  await room.join('SoloAchv', 0);
  room._running = false;
  room._countdownTimer = 0;
  room._step(0.05);
  const msgs = [];
  room.onMessage('achievementsUnlocked', (d) => msgs.push(d));

  const me = room.state.players.get(room.sessionId);
  me.score = SERVER.match.targetScore; // legacy semantics: score-target win
  room._step(0.05);
  assert.equal(room.state.matchState, 'gameover', 'LOCAL: forced win');
  assert.equal(msgs.length, 1, 'LOCAL: exactly one achievementsUnlocked');
  assert.deepEqual(Object.keys(msgs[0]), ['ids'], 'LOCAL: identical payload shape');
  assert.ok(msgs[0].ids.includes('first_run'), 'LOCAL: first_run unlocked');

  room.send('playAgain');
  room._countdownTimer = 0;
  room._step(0.05);
  me.score = SERVER.match.targetScore; // win again: nothing new to unlock
  room._step(0.05);
  assert.equal(room.state.matchState, 'gameover', 'LOCAL: replay won again');
  assert.equal(msgs.length, 1, 'LOCAL: replay emits NO duplicate');
  room.leave();
}

console.log('ok — achievementsIntegration.test.mjs: forced gameover -> ONE achievementsUnlocked (first_run + wave_5), player file persists the array, re-finalize stays silent, LocalRoom payload parity');
process.exit(0);
