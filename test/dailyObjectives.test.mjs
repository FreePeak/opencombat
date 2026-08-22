// Objective-Based Dailies (PRD-daily-objectives.md, Cycle 18) — mirror of the
// cycle-17 weeklies objectives on the daily pipeline:
//   - dailyObjectives(dateStr) picks 2 DISTINCT entries deterministically
//   - evaluateDailyRun truth table with inclusive boundaries
//   - sticky merge across attempts within a day; new day resets wholesale
//   - integration: forced daily finalize persists daily.objectives;
//     /api/daily exposes the objectives array
// Run: node --test test/dailyObjectives.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  DAILY_OBJECTIVES, dailyObjectives, evaluateDailyRun, mergeDailyObjectives,
  utcDateStr, dailySeed,
} from '../src/shared/sim/dailyRun.js';

test('objective table shape', () => {
  assert.equal(DAILY_OBJECTIVES.length, 4);
  assert.deepEqual(DAILY_OBJECTIVES.map(o => o.id),
    ['wave_5', 'wave_8', 'score_500', 'score_1200']);
  for (const o of DAILY_OBJECTIVES) {
    assert.equal(typeof o.description, 'string');
    assert.ok(o.description.length > 0);
    assert.equal(typeof o.test, 'function');
  }
});

test('dailyObjectives deterministic + 2 distinct (AC1)', () => {
  const day = utcDateStr();
  const a = dailyObjectives(day);
  const b = dailyObjectives(day);
  assert.deepEqual(a, b, 'same day -> same picks');
  assert.equal(a.length, 2, 'two picks per day');
  assert.equal(new Set(a.map(o => o.id)).size, 2, 'picks distinct');
  // seed form agrees with key form
  assert.deepEqual(dailyObjectives(dailySeed(day)), a);
  // shared table never mutated by picking
  const before = [...DAILY_OBJECTIVES];
  dailyObjectives('2026-01-01');
  dailyObjectives('2027-12-31');
  assert.deepEqual(DAILY_OBJECTIVES, before, 'table untouched');
  // distinct across sampled days
  const days = ['2026-08-20', '2026-08-21', '2026-08-22', '2027-01-01'];
  const pairs = days.map(dailyObjectives);
  for (const p of pairs) {
    assert.equal(p.length, 2);
    assert.notEqual(p[0].id, p[1].id);
  }
  assert.ok(pairs.some(p => p[0].id !== pairs[0][0].id || p[1].id !== pairs[0][1].id),
    'at least one sampled day differs from the first');
});

test('evaluateDailyRun truth table, boundaries inclusive (AC2)', () => {
  const all = DAILY_OBJECTIVES;
  const atThreshold = Object.fromEntries(
    evaluateDailyRun(all, { wave: 5, score: 500 }).map(r => [r.id, r.done]));
  assert.ok(atThreshold.wave_5 && atThreshold.score_500, 'exact threshold counts');
  assert.ok(!atThreshold.wave_8 && !atThreshold.score_1200, 'higher tiers unmet');
  const allDone = Object.fromEntries(
    evaluateDailyRun(all, { wave: 8, score: 1200 }).map(r => [r.id, r.done]));
  assert.ok(Object.values(allDone).every(Boolean), 'all done at max thresholds');
  const below = Object.fromEntries(
    evaluateDailyRun(all, { wave: 4, score: 499 }).map(r => [r.id, r.done]));
  assert.ok(!Object.values(below).some(Boolean), 'just-below is not done');
});

test('sticky merge: once true stays true; new day resets (AC3)', () => {
  const day = '2026-08-22';
  const defs = dailyObjectives(day);
  // attempt1: weak run -> nothing done
  let merged = mergeDailyObjectives(null, day, evaluateDailyRun(defs, { wave: 3, score: 100 }));
  assert.ok(merged.objectives.every(o => !o.done), 'attempt1: nothing done');

  // attempt2: strong run -> both done
  merged = mergeDailyObjectives(merged, day, evaluateDailyRun(defs, { wave: 8, score: 1300 }));
  assert.ok(merged.objectives.every(o => o.done), 'attempt2: both done');

  // attempt3: weak rerun same day -> still done (sticky)
  merged = mergeDailyObjectives(merged, day, evaluateDailyRun(defs, { wave: 2, score: 10 }));
  assert.ok(merged.objectives.every(o => o.done), 'sticky: done survives weak rerun');
  assert.equal(merged.date, day);

  // new day replaces wholesale
  const day2 = '2026-08-23';
  const defs2 = dailyObjectives(day2);
  const r4 = evaluateDailyRun(defs2, { wave: 3, score: 100 });
  merged = mergeDailyObjectives(merged, day2, r4);
  assert.equal(merged.date, day2, 'date replaced');
  assert.deepEqual(merged.objectives.map(o => o.done), r4.map(r => r.done),
    "new day resets objective dones to this run's results");
});

// --- Integration: force daily finalize -> persisted objectives + endpoint ---
{
  const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond, timeoutMs = 10000, label = 'condition') => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return;
      await waitMs(30);
    }
    throw new Error('timeout waiting for ' + label);
  };

  test('integration: finalize writes sticky daily.objectives; /api/daily has objectives (AC4+AC5)', async () => {
    const { Server, WebSocketTransport } = await import('colyseus');
    const { Client } = await import('@colyseus/sdk');
    const { default: GameRoom } = await import('../src/server/rooms/GameRoom.js');
    const { WorldState } = await import('../src/server/schema/StateSchema.js');
    const { SERVER } = await import('../src/server/config.js');
    const { buildHttpApp } = await import('../src/server/http.js');
    const { resetRateLimit } = await import('../src/server/ratelimit.js');
    const persistence = await import('../src/server/persistence.js');
    SERVER.rateLimit.capacity = 10000;
    resetRateLimit();

    const httpServer = http.createServer();
    const gameServer = new Server({
      transport: new WebSocketTransport({ server: httpServer }),
      express: (app) => buildHttpApp(app),
    });
    gameServer.define('daily', GameRoom);
    await gameServer.listen(0);
    const port = httpServer.address().port;

    try {
      const name = 'DailyObjT1';
      const file = path.join(persistence._dirForTests(), `${name}.json`);
      try { fs.rmSync(file); } catch {}

      // Seed a prior same-day record with weak dones so we can prove
      // stickiness through the real finalize path.
      const today = utcDateStr();
      const defs = dailyObjectives(today);
      fs.writeFileSync(file, JSON.stringify({
        name,
        daily: mergeDailyObjectives(null, today, evaluateDailyRun(defs, { wave: 3, score: 50 })),
      }));

      // Force an all-dead wipe above both thresholds (banked score kept below
      // targetScore=100 so the win-by-score path cannot pre-empt).
      const c = new Client(`ws://localhost:${port}`);
      const r = await c.create('daily', { name, character: 0, mode: 'daily' }, WorldState);
      await waitFor(() => r.state?.matchState === 'playing', 8000, 'daily match playing');
      const sr = [...GameRoom.instances].find((x) => x.roomId === r.roomId);
      sr.state.wave = Math.max(sr.state.wave, 9);
      for (const p of sr.state.players.values()) {
        p.score = 90;
        p.x = 0; p.z = 0;
        p.hp = 0;
      }
      await waitFor(() => sr.state.matchState === 'gameover', 3000, 'all-dead finalize');
      persistence.flushAll();

      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(rec.daily.date, today, 'still the same day');
      assert.ok(Array.isArray(rec.daily.objectives) && rec.daily.objectives.length === 2,
        'persisted daily.objectives has 2 entries');
      const expected = Object.fromEntries(
        evaluateDailyRun(defs, { wave: sr.state.wave, score: 90 }).map(x => [x.id, x.done]));
      for (const o of rec.daily.objectives) {
        assert.equal(o.done, expected[o.id] === true,
          `objective ${o.id} matches expected evaluation ${o.done}`);
      }

      // Endpoint: definitions present + leaderboard objectivesDone count.
      const res = await fetch(`http://127.0.0.1:${port}/api/daily`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.objectives) && body.objectives.length === 2,
        '/api/daily exposes the 2 objective definitions');
      for (const d of body.objectives) {
        assert.equal(typeof d.id, 'string');
        assert.equal(typeof d.description, 'string');
        assert.ok(!('test' in d), 'predicate functions not leaked over HTTP');
      }
      const row = body.leaderboard.find(e => e.name === name);
      assert.ok(row, 'leaderboard contains our player');
      const wantDone = rec.daily.objectives.filter(o => o.done === true).length;
      assert.equal(row.objectivesDone, wantDone, 'objectivesDone counts dones');

      r.leave();
      try { fs.rmSync(file); } catch {}
      persistence._resetForTests();
    } finally {
      // Bound shutdown so node --test always settles (weeklyObjectives precedent).
      await Promise.race([
        gameServer.gracefullyShutdown(false),
        waitMs(2500),
      ]).catch(() => {});
      httpServer.close();
    }
  });
}

process.exit(0);
