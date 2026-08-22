// Weekly Gauntlet (PRD-weekly-gauntlet.md) — server-side Step B:
//   - create('weekly') rooms run this ISO week's STACKED modifiers: wave-1
//     enemies spawn at waveEnemyHp * enemyHpMul (>= any single daily row)
//     with enemyCountBonus extra slots, on the week-seeded LCG
//   - ALL players dead simultaneously -> endMatch + persisted weekly.
//     {week,bestScore,lastPlayed} merge + 'dailyResult' tagged kind:'weekly'
//   - GET /api/weekly returns { week, seed, modifiers, rewards, leaderboard }
//     and the leaderboard picks up the just-finished player's bestScore
// Run: node --test test/weeklyIntegration.test.mjs
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
import { flushAll, _resetForTests, _dirForTests } from '../src/server/persistence.js';
import { utcWeekKey, weeklySeed, weeklyModifiers } from '../src/shared/sim/weeklyRun.js';
import { waveEnemyCount, waveEnemyHp } from '../src/shared/waves.js';

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
resetRateLimit();
const httpServer = http.createServer();
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app)
});
gameServer.define('game', GameRoom);
gameServer.define('weekly', GameRoom);
await gameServer.listen(0);
const port = httpServer.address().port;

const roomOf = (r) => [...GameRoom.instances].find((x) => x.roomId === r.roomId);
const aliveCount = (state) => state.enemies.filter((e) => e.hp > 0).length;
const playerFile = (name) => path.join(_dirForTests(), `${name}.json`);
const rmPlayerFile = (name) => { try { fs.rmSync(playerFile(name)); } catch {} };

// --- Weekly room: mode gate + stacked-modifier wave 1 -------------------------
{
  rmPlayerFile('WeeklyT1');
  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('weekly', { name: 'WeeklyT1', character: 0, mode: 'weekly' }, WorldState);
  await waitFor(() => r.state?.matchState === 'playing', 8000, 'weekly match playing');
  const sr = roomOf(r);
  assert.equal(sr.mode, 'weekly', 'room stored mode=weekly');

  const week = utcWeekKey();
  const mods = weeklyModifiers(week);
  assert.equal(sr.dailyMods.label, mods.label, 'room rides this ISO week\'s stack');
  const expectedHp = Math.max(1, Math.round(waveEnemyHp(1) * mods.enemyHpMul));
  assert.ok(expectedHp >= waveEnemyHp(1),
    `stacked hp ${expectedHp} >= plain waveEnemyHp ${waveEnemyHp(1)} (AC3)`);
  const expectedCount = Math.min(
    waveEnemyCount(1) + Math.max(0, Math.floor(mods.enemyCountBonus)),
    SERVER.enemy.pool
  );
  assert.equal(aliveCount(sr.state), expectedCount,
    `wave 1 activates base count + enemyCountBonus (${expectedCount})`);
  assert.ok(sr.state.enemies.slice(0, expectedCount).every((e) => e.hp === expectedHp),
    `every wave-1 enemy hp scaled by the stacked enemyHpMul -> ${expectedHp}`);
  // Unused pool slots stay dead.
  assert.ok(sr.state.enemies.slice(expectedCount).every((e) => e.hp === 0),
    'pool slots beyond weekly count stay dead');

  // --- All-dead finalize: endMatch + persisted record + kind:'weekly' banner --
  let resultMsg = null;
  r.onMessage('dailyResult', (msg) => { resultMsg = msg; });

  // Force the wipe with a banked score (>0 but below targetScore=100 so the
  // win-by-score path cannot pre-empt the all-dead finalize).
  for (const p of sr.state.players.values()) {
    p.score = 50;
    p.x = 0; p.z = 0;
    p.hp = 0;
  }
  await waitFor(() => sr.state.matchState === 'gameover', 3000, 'all-dead ends the weekly run');
  await waitFor(() => !!resultMsg, 3000, 'dailyResult(kind=weekly) broadcast');
  assert.equal(resultMsg.kind, 'weekly', 'banner payload tagged kind=weekly');
  assert.ok(Array.isArray(resultMsg.results) && resultMsg.results.length >= 1,
    'dailyResult.results present');
  const row = resultMsg.results.find((x) => x.name === 'WeeklyT1');
  assert.ok(row, 'result row for our player');
  for (const k of ['sid', 'name', 'score', 'bestScore', 'rewardXp']) {
    assert.ok(k in row, `result row has ${k}`);
  }

  // Persisted record (debounced save flushed for the test).
  flushAll();
  const rec = JSON.parse(fs.readFileSync(playerFile('WeeklyT1'), 'utf8'));
  assert.equal(rec.weekly.week, utcWeekKey(), 'weekly.week is the current ISO week');
  assert.ok(rec.weekly.bestScore > 0, 'weekly.bestScore > 0');
  assert.equal(rec.weekly.bestScore, 50, 'bestScore records the final score');
  assert.equal(rec.weekly.lastPlayed, utcWeekKey(), 'lastPlayed stamped with the week');
  assert.ok(!('streak' in rec.weekly), 'weekly deliberately has NO streak');
  assert.equal(row.rewardXp, 150, 'floor tier of the flat ladder pays 150 XP');

  // --- GET /api/weekly shape + leaderboard pickup -------------------------------
  const res = await fetch(`http://127.0.0.1:${port}/api/weekly`);
  assert.equal(res.status, 200, '/api/weekly responds 200');
  const body = await res.json();
  for (const key of ['week', 'seed', 'modifiers', 'rewards', 'leaderboard']) {
    assert.ok(key in body, `/api/weekly has ${key}`);
  }
  assert.equal(body.week, utcWeekKey(), 'week is the current UTC ISO week');
  assert.equal(body.seed, weeklySeed(body.week), 'seed derives from the week key');
  const wmods = weeklyModifiers(body.week);
  assert.deepEqual(body.modifiers, {
    label: wmods.label,
    description: wmods.description,
    enemyHpMul: wmods.enemyHpMul,
    enemySpeedMul: wmods.enemySpeedMul,
    enemyCountBonus: wmods.enemyCountBonus,
  }, 'modifiers mirror weeklyModifiers');
  assert.ok(Array.isArray(body.rewards) && body.rewards.length === 5, 'rewards ladder present');
  for (let i = 1; i < body.rewards.length; i++) {
    assert.ok(body.rewards[i] >= body.rewards[i - 1], 'rewards ladder monotonic');
  }
  assert.ok(Array.isArray(body.leaderboard), 'leaderboard array present');
  assert.ok(body.leaderboard.some((e) => e.name === 'WeeklyT1' && e.score === rec.weekly.bestScore),
    'leaderboard contains the finished player with their bestScore');

  r.leave();
  rmPlayerFile('WeeklyT1');
  _resetForTests();
}

// --- Plain waves rooms untouched by weekly wiring ------------------------------
{
  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('game', { name: 'WavesStillW' }, WorldState);
  await waitFor(() => r.state?.matchState === 'playing', 8000, 'waves match playing');
  const sr = roomOf(r);
  assert.equal(sr.mode, 'waves', 'plain game room stays mode=waves');
  assert.equal(aliveCount(sr.state), waveEnemyCount(1), 'waves: vanilla wave-1 count');
  assert.ok(sr.state.enemies.slice(0, waveEnemyCount(1)).every((e) => e.hp === waveEnemyHp(1)),
    'waves: vanilla unscaled hp');
  r.leave();
  rmPlayerFile('WavesStillW');
  _resetForTests();
}

// --- VICTORY parity: winning the finale finalizes the weekly run -------------
{
  rmPlayerFile('WeeklyWin');
  const prevFinale = SERVER.wave.finaleWave;
  SERVER.wave.finaleWave = 1;
  try {
    const c = new Client(`ws://localhost:${port}`);
    const r = await c.create('weekly', { name: 'WeeklyWin', character: 0, mode: 'weekly' }, WorldState);
    await waitFor(() => r.state?.matchState === 'playing', 8000, 'weekly victory match playing');
    const sr = roomOf(r);
    let resultMsg = null;
    r.onMessage('dailyResult', (d) => { resultMsg = d; });

    const me = sr.state.players.get(r.sessionId);
    me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
    // Wave 1 IS the finale: surge fields the whole pool — cone-safe fan.
    const alive = [...sr.state.enemies].filter((e) => e.hp > 0);
    const spacing = Math.min(0.3, 0.9 / Math.max(1, alive.length - 1));
    alive.forEach((e, i) => {
      e.hp = 1;
      const ang = (i - (alive.length - 1) / 2) * spacing;
      e.x = 1.8 * Math.cos(ang);
      e.z = 1.8 * Math.sin(ang);
      sr.enemyStunUntil.set(e, Date.now() + 5000);
    });
    r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
    await waitFor(() => sr.state.matchState === 'intermission', 3000, 'weekly finale cleared');
    for (let i = 0; i < 12 && me.pendingChoices.length > 0; i++) {
      r.send('chooseUpgrade', { choice: me.pendingChoices[0] });
      await waitMs(80);
    }
    r.send('nextWave'); // advancing past the finale -> VICTORY
    await waitFor(() => sr.state.matchState === 'gameover', 3000, 'weekly victory gameover');
    assert.equal(sr.state.victory, true, 'weekly victory flag set');
    await waitFor(() => !!resultMsg, 3000, 'dailyResult(kind=weekly) on victory');
    assert.equal(resultMsg.kind, 'weekly');

    flushAll();
    const rec = JSON.parse(fs.readFileSync(playerFile('WeeklyWin'), 'utf8'));
    assert.ok(rec.weekly, 'weekly blob written on victory');
    assert.equal(rec.weekly.week, utcWeekKey());
    assert.ok((rec.career?.victories ?? 0) >= 1, 'career victories recorded too');
    rmPlayerFile('WeeklyWin');
    r.leave();
  } finally {
    SERVER.wave.finaleWave = prevFinale;
  }
}

console.log('ok — weeklyIntegration.test.mjs: weekly mode gate + stacked modifier scaling, all-dead finalize + weekly persistence + kind:weekly banner, /api/weekly shape + leaderboard, waves untouched');
process.exit(0);
