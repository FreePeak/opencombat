// Daily Gauntlet (PRD-daily-gauntlet.md) — server-side Step B:
//   - create('daily') rooms run today's modifiers: wave-1 enemies spawn at
//     waveEnemyHp * enemyHpMul with enemyCountBonus extra slots, and the
//     seeded LCG makes same-day layouts reproducible across rooms
//   - GET /api/daily returns { date, seed, modifiers, rewards, leaderboard }
//   - ALL players dead simultaneously -> endMatch path + per-player persisted
//     record (daily.streak/date/bestScore) + 'dailyResult' broadcast
//   - /api/daily leaderboard picks up the just-finished player's score
// Run: node --test test/daily.test.mjs
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
import { utcDateStr, dailySeed, dailyModifiers } from '../src/shared/sim/dailyRun.js';
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
gameServer.define('daily', GameRoom);
await gameServer.listen(0);
const port = httpServer.address().port;

const roomOf = (r) => [...GameRoom.instances].find((x) => x.roomId === r.roomId);
const aliveCount = (state) => state.enemies.filter((e) => e.hp > 0).length;
const playerFile = (name) => path.join(_dirForTests(), `${name}.json`);
const rmPlayerFile = (name) => { try { fs.rmSync(playerFile(name)); } catch {} };

// --- Daily room: mode gate + modifier-scaled wave 1 --------------------------
{
  rmPlayerFile('DailyT1');
  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('daily', { name: 'DailyT1', character: 0, mode: 'daily' }, WorldState);
  await waitFor(() => r.state?.matchState === 'playing', 8000, 'daily match playing');
  const sr = roomOf(r);
  assert.equal(sr.mode, 'daily', 'room stored mode=daily');

  const mods = dailyModifiers(utcDateStr());
  const expectedHp = Math.max(1, Math.round(waveEnemyHp(1) * mods.enemyHpMul));
  const expectedCount = Math.min(
    waveEnemyCount(1) + Math.max(0, Math.floor(mods.enemyCountBonus)),
    SERVER.enemy.pool
  );
  assert.equal(aliveCount(sr.state), expectedCount,
    `wave 1 activates base count + enemyCountBonus (${expectedCount})`);
  assert.ok(sr.state.enemies.slice(0, expectedCount).every((e) => e.hp === expectedHp),
    `every wave-1 enemy hp scaled by enemyHpMul -> ${expectedHp}`);
  // Unused pool slots stay dead.
  assert.ok(sr.state.enemies.slice(expectedCount).every((e) => e.hp === 0),
    'pool slots beyond daily count stay dead');

  // Reproducible layouts: a second same-day daily room samples identical
  // positions from the date-seeded LCG (orbs spawn first at create).
  const c2 = new Client(`ws://localhost:${port}`);
  const r2 = await c2.create('daily', { name: 'DailyT2', character: 0, mode: 'daily' }, WorldState);
  await waitFor(() => r2.state?.matchState === 'playing', 8000, 'second daily match playing');
  const sr2 = roomOf(r2);
  assert.equal(sr.state.orbs[0].x, sr2.state.orbs[0].x, 'same-day orb layout x matches');
  assert.equal(sr.state.orbs[0].z, sr2.state.orbs[0].z, 'same-day orb layout z matches');

  // Force non-trivial modifiers on the live room so wave sizing/scaling is
  // exercised no matter which table row today's seed picks.
  sr.dailyMods = { ...mods, enemyHpMul: 3, enemySpeedMul: 2.5, enemyCountBonus: 5 };
  sr.spawnWave(2);
  const forcedCount = Math.min(waveEnemyCount(2) + 5, SERVER.enemy.pool);
  const forcedHp = Math.max(1, Math.round(waveEnemyHp(2) * 3));
  assert.equal(aliveCount(sr.state), forcedCount, 'forced bonus adds slots');
  assert.ok(sr.state.enemies.slice(0, forcedCount).every((e) => e.hp === forcedHp),
    `forced enemyHpMul scales every slot -> ${forcedHp}`);
  assert.equal(sr.enemySpeedMul, mods.enemySpeedMul,
    'enemySpeedMul rides the room multiplier (fixed at create)');

  r.leave();
  r2.leave();
}

// --- Waves rooms untouched by daily wiring ------------------------------------
{
  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('game', { name: 'WavesStill' }, WorldState);
  await waitFor(() => r.state?.matchState === 'playing', 8000, 'waves match playing');
  const sr = roomOf(r);
  assert.equal(sr.mode, 'waves', 'plain game room stays mode=waves');
  assert.equal(aliveCount(sr.state), waveEnemyCount(1), 'waves: vanilla wave-1 count');
  assert.ok(sr.state.enemies.slice(0, waveEnemyCount(1)).every((e) => e.hp === waveEnemyHp(1)),
    'waves: vanilla unscaled hp');
  r.leave();
}

// --- GET /api/daily shape ------------------------------------------------------
{
  const res = await fetch(`http://127.0.0.1:${port}/api/daily`);
  assert.equal(res.status, 200, '/api/daily responds 200');
  const body = await res.json();
  for (const key of ['date', 'seed', 'modifiers', 'rewards', 'leaderboard']) {
    assert.ok(key in body, `/api/daily has ${key}`);
  }
  assert.equal(body.date, utcDateStr(), 'date is today UTC');
  assert.equal(body.seed, dailySeed(body.date), 'seed derives from date');
  const mods = dailyModifiers(body.date);
  assert.deepEqual(body.modifiers, {
    label: mods.label,
    description: mods.description,
    enemyHpMul: mods.enemyHpMul,
    enemySpeedMul: mods.enemySpeedMul,
    enemyCountBonus: mods.enemyCountBonus,
  }, 'modifiers mirror dailyModifiers');
  assert.ok(Array.isArray(body.rewards) && body.rewards.length >= 1, 'rewards table present');
  assert.ok(Array.isArray(body.leaderboard), 'leaderboard array present');
}

// --- All-dead finalize: endMatch + persisted record + dailyResult --------------
{
  rmPlayerFile('DailyT1');
  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('daily', { name: 'DailyT1', character: 0, mode: 'daily' }, WorldState);
  await waitFor(() => r.state?.matchState === 'playing', 8000, 'daily match playing');
  const sr = roomOf(r);

  let resultMsg = null;
  r.onMessage('dailyResult', (msg) => { resultMsg = msg; });

  // Force the wipe: every connected player dead simultaneously.
  for (const p of sr.state.players.values()) {
    p.x = 0; p.z = 0;
    p.hp = 0;
  }
  await waitFor(() => sr.state.matchState === 'gameover', 3000, 'all-dead ends the daily run');
  await waitFor(() => !!resultMsg, 3000, 'dailyResult broadcast');
  assert.ok(Array.isArray(resultMsg.results) && resultMsg.results.length >= 1,
    'dailyResult.results present');
  const row = resultMsg.results.find((x) => x.name === 'DailyT1');
  assert.ok(row, 'result row for our player');
  for (const k of ['sid', 'name', 'score', 'streak', 'rewardXp']) {
    assert.ok(k in row, `result row has ${k}`);
  }

  // Persisted record (debounced save flushed for the test).
  flushAll();
  const rec = JSON.parse(fs.readFileSync(playerFile('DailyT1'), 'utf8'));
  assert.ok(rec.daily.streak >= 1, 'daily.streak >= 1');
  assert.equal(rec.daily.date, utcDateStr(), 'daily.date is today');
  assert.equal(typeof rec.daily.bestScore, 'number', 'daily.bestScore is a number');
  assert.equal(rec.daily.lastPlayed, utcDateStr(), 'daily.lastPlayed is today');
  assert.equal(rec.daily.bestScore, row.score, 'bestScore records the final score');

  // Leaderboard picks up the just-finished run (AC5).
  const res = await fetch(`http://127.0.0.1:${port}/api/daily`);
  const body = await res.json();
  assert.ok(body.leaderboard.some((e) => e.name === 'DailyT1' && e.score === row.score),
    'leaderboard contains the finished player');

  r.leave();
  rmPlayerFile('DailyT1');
  rmPlayerFile('DailyT2');
  rmPlayerFile('WavesStill');
  _resetForTests();
}

// --- VICTORY finalize: winning the wave finale records the streak -------------
{
  rmPlayerFile('DailyWin');
  const prevFinale = SERVER.wave.finaleWave;
  SERVER.wave.finaleWave = 2; // two-wave run for speed
  try {
    const c = new Client(`ws://localhost:${port}`);
    const r = await c.create('daily', { name: 'DailyWin', character: 0, mode: 'daily' }, WorldState);
    await waitFor(() => r.state?.matchState === 'playing', 8000, 'daily victory match playing');
    const sr = roomOf(r);
    let sawResult = null;
    r.onMessage('dailyResult', (d) => { sawResult = d; });

    const me = sr.state.players.get(r.sessionId);
    me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
    const clearWave = async () => {
      const alive = [...sr.state.enemies].filter((e) => e.hp > 0);
      // Finale SURGE may field the whole pool: cone-safe adaptive fan.
      const spacing = Math.min(0.3, 0.9 / Math.max(1, alive.length - 1));
      alive.forEach((e, i) => {
        e.hp = 1;
        const ang = (i - (alive.length - 1) / 2) * spacing;
        e.x = 1.8 * Math.cos(ang);
        e.z = 1.8 * Math.sin(ang);
        sr.enemyStunUntil.set(e, Date.now() + 5000);
      });
      r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
      await waitFor(() => sr.state.matchState === 'intermission', 3000,
        'victory-run clear');
      // Drain level-up cards (pause wall would block the next advance).
      for (let i = 0; i < 12 && me.pendingChoices.length > 0; i++) {
        r.send('chooseUpgrade', { choice: me.pendingChoices[0] });
        await waitMs(80);
      }
    };

    await clearWave();
    r.send('nextWave');
    await waitFor(() => sr.state.matchState === 'playing', 8000, 'victory wave 2 playing');
    await clearWave();
    r.send('nextWave'); // advancing past the finale -> co-op VICTORY
    await waitFor(() => sr.state.matchState === 'gameover', 3000, 'daily victory gameover');
    assert.equal(sr.state.victory, true, 'daily victory flag set');

    // THE PIN: a won gauntlet IS a completed run — finalize must have fired.
    await waitFor(() => sawResult, 3000, 'dailyResult broadcast on victory');
    flushAll();
    const blob = JSON.parse(fs.readFileSync(playerFile('DailyWin'), 'utf8'));
    assert.ok(blob.daily, 'daily blob written on victory');
    assert.equal(blob.daily.streak, 1, 'victory counts as a completed run');
    assert.equal(blob.daily.lastPlayed, utcDateStr());
    assert.ok((blob.career?.victories ?? 0) >= 1, 'career victories recorded too');
    rmPlayerFile('DailyWin');
    r.leave();
  } finally {
    SERVER.wave.finaleWave = prevFinale;
  }
}

console.log('ok — daily.test.mjs: daily mode gate + modifier scaling + seeded layout parity, waves untouched, /api/daily shape, all-dead finalize + persistence + leaderboard');
process.exit(0);
