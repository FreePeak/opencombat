// Objective-Based Weeklies (PRD-weekly-gauntlet.md ADDENDUM Cycle 17):
//   - weeklyObjectives(weekKey) picks 2 DISTINCT entries deterministically
//   - evaluateWeeklyRun truth table with inclusive boundaries
//   - sticky merge across attempts within a week; new week resets wholesale
//   - integration: forced weekly finalize persists weekly.objectives;
//     /api/weekly exposes the objectives array
// Run: node --test test/weeklyObjectives.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  WEEKLY_OBJECTIVES, weeklyObjectives, evaluateWeeklyRun, mergeWeeklyObjectives,
  utcWeekKey, weeklySeed,
} from '../src/shared/sim/weeklyRun.js';

test('objective table shape', () => {
  assert.equal(WEEKLY_OBJECTIVES.length, 4);
  assert.deepEqual(WEEKLY_OBJECTIVES.map(o => o.id),
    ['wave_6', 'wave_10', 'score_800', 'score_2000']);
  for (const o of WEEKLY_OBJECTIVES) {
    assert.equal(typeof o.description, 'string' && o.description.length > 0 ? 'string' : undefined);
    assert.equal(typeof o.test, 'function');
  }
});

test('weeklyObjectives deterministic + 2 distinct (AC1)', () => {
  const wk = utcWeekKey();
  const a = weeklyObjectives(wk);
  const b = weeklyObjectives(wk);
  assert.deepEqual(a, b, 'same week -> same picks');
  assert.equal(a.length, 2, 'two picks per week');
  assert.equal(new Set(a.map(o => o.id)).size, 2, 'picks distinct');
  // seed form agrees with key form (mirrors weeklyModifiers contract)
  assert.deepEqual(weeklyObjectives(weeklySeed(wk)), a);
  // shared table never mutated by picking
  const before = [...WEEKLY_OBJECTIVES];
  weeklyObjectives('2026-W01');
  weeklyObjectives('2027-W02');
  assert.deepEqual(WEEKLY_OBJECTIVES, before, 'table untouched');
  // distinct across sampled weeks
  const weeks = ['2026-W01', '2026-W02', '2026-W03', '2026-W34', '2030-W10'];
  const pairs = weeks.map(weeklyObjectives);
  for (const p of pairs) {
    assert.equal(p.length, 2);
    assert.notEqual(p[0].id, p[1].id);
  }
  assert.ok(pairs.some(p => p[0].id !== pairs[0][0].id || p[1].id !== pairs[0][1].id),
    'at least one sampled week differs from the first');
});

test('evaluateWeeklyRun truth table, boundaries inclusive (AC1)', () => {
  const all = WEEKLY_OBJECTIVES;
  assert.deepEqual(evaluateWeeklyRun(all, { wave: 6, score: 0 }),
    [{ id: 'wave_6', done: true }, { id: 'wave_10', done: false },
     { id: 'score_800', done: false }, { id: 'score_2000', done: false }]);
  assert.deepEqual(evaluateWeeklyRun(all, { wave: 10, score: 2000 }),
    [{ id: 'wave_6', done: true }, { id: 'wave_10', done: true },
     { id: 'score_800', done: true }, { id: 'score_2000', done: true }]);
  // just-below boundaries are NOT done
  const below = Object.fromEntries(
    evaluateWeeklyRun(all, { wave: 5, score: 799 }).map(r => [r.id, r.done]));
  assert.ok(!below.wave_6 && !below.score_800);
});

test('sticky merge: partials kept, once true stays true; new week resets (AC2)', () => {
  const wk = '2026-W34';
  const defs = weeklyObjectives(wk);
  // attempt1: wave 4 / 100 -> neither of wave_6/score_800 style picks done
  const r1 = evaluateWeeklyRun(defs, { wave: 4, score: 100 });
  let merged = mergeWeeklyObjectives(null, wk, r1);
  assert.ok(merged.objectives.every(o => !o.done), 'attempt1: nothing done');

  // attempt2: wave 7 / 900 -> both done
  const r2 = evaluateWeeklyRun(defs, { wave: 7, score: 900 });
  merged = mergeWeeklyObjectives(merged, wk, r2);
  assert.ok(merged.objectives.every(o => o.done), 'attempt2: both done');

  // attempt3: weak run {wave:2} -> still done (sticky)
  const r3 = evaluateWeeklyRun(defs, { wave: 2, score: 10 });
  merged = mergeWeeklyObjectives(merged, wk, r3);
  assert.ok(merged.objectives.every(o => o.done), 'sticky: done survives weak rerun');
  assert.equal(merged.week, wk);

  // new week replaces wholesale — fresh dones from the new run only
  const wk2 = '2026-W35';
  const defs2 = weeklyObjectives(wk2);
  const r4 = evaluateWeeklyRun(defs2, { wave: 4, score: 100 });
  merged = mergeWeeklyObjectives(merged, wk2, r4);
  assert.equal(merged.week, wk2, 'week replaced');
  assert.deepEqual(merged.objectives.map(o => o.done), r4.map(r => r.done),
    'new week resets objective dones to this run\'s results');
});

// --- Integration: force weekly finalize -> persisted objectives + endpoint ---
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

  test('integration: finalize writes sticky weekly.objectives; /api/weekly has objectives (AC3)', async () => {
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
    gameServer.define('weekly', GameRoom);
    await gameServer.listen(0);
    const port = httpServer.address().port;

    try {
      const name = 'ObjT1';
      const file = path.join(persistence._dirForTests(), `${name}.json`);
      try { fs.rmSync(file); } catch {}

      // Seed a prior same-week record with weak dones so we can prove
      // stickiness through the real finalize path.
      const week = utcWeekKey();
      const defs = weeklyObjectives(week);
      fs.writeFileSync(file, JSON.stringify({
        name,
        weekly: mergeWeeklyObjectives(null, week, evaluateWeeklyRun(defs, { wave: 4, score: 100 })),
      }));
      // attempt2 via the live room: force an all-dead wipe at high wave/score.
      const c = new Client(`ws://localhost:${port}`);
      const r = await c.create('weekly', { name, character: 0, mode: 'weekly' }, WorldState);
      await waitFor(() => r.state?.matchState === 'playing', 8000, 'weekly match playing');
      const sr = [...GameRoom.instances].find((x) => x.roomId === r.roomId);

      // Push the run above both thresholds before wiping (banked score kept
      // below targetScore=100 so the win-by-score path cannot pre-empt).
      sr.state.wave = Math.max(sr.state.wave, 11);
      for (const p of sr.state.players.values()) {
        p.score = 90;
        p.x = 0; p.z = 0;
        p.hp = 0;
      }
      await waitFor(() => sr.state.matchState === 'gameover', 3000, 'all-dead finalize');
      persistence.flushAll();

      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(rec.weekly.week, week, 'still the same week');
      assert.ok(Array.isArray(rec.weekly.objectives) && rec.weekly.objectives.length === 2,
        'persisted weekly.objectives has 2 entries');
      const expected = Object.fromEntries(
        evaluateWeeklyRun(defs, { wave: sr.state.wave, score: 90 }).map(x => [x.id, x.done]));
      // sticky: any objective already done in the seeded attempt stays done,
      // and this run's clears register too.
      for (const o of rec.weekly.objectives) {
        assert.equal(o.done, expected[o.id] === true,
          `objective ${o.id} matches expected evaluation ${o.done}`);
      }

      // Endpoint: definitions present + leaderboard objectivesDone count.
      const res = await fetch(`http://127.0.0.1:${port}/api/weekly`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.objectives) && body.objectives.length === 2,
        '/api/weekly exposes the 2 objective definitions');
      for (const d of body.objectives) {
        assert.equal(typeof d.id, 'string');
        assert.equal(typeof d.description, 'string');
        assert.ok(!('test' in d), 'predicate functions not leaked over HTTP');
      }
      const row = body.leaderboard.find(e => e.name === name);
      assert.ok(row, 'leaderboard contains our player');
      const wantDone = rec.weekly.objectives.filter(o => o.done === true).length;
      assert.equal(row.objectivesDone, wantDone, 'objectivesDone counts dones');

      r.leave();
      try { fs.rmSync(file); } catch {}
      persistence._resetForTests();
    } finally {
      // Shutdown can dangle on room-dispose timers — bound it so this test
      // always settles and reports. exit=false: colyseus otherwise calls
      // process.exit() itself, which would drop this subtest's result.
      await Promise.race([
        gameServer.gracefullyShutdown(false),
        waitMs(2500),
      ]).catch(() => {});
      httpServer.close();
    }
  });
}
