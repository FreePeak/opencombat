// P1.3 Slice 4 — Layer A unit tests for src/shared/sim/matchPhases.js (D7
// pause wall / auto-pick-before-pause ordering + intermission-deadline
// extension, D8 match reset) and the stretch D1 wave activation in
// src/shared/waves.js (activateWave). Pins the extracted contract
// independently of either room: bare WorldState + plain ctx over a fake
// clock and injected dt/samplers, so no sockets, timers or sleeps are needed
// (test style contract: sim behavior is driven directly, never awaited
// against wall time). Also guards the shared-sim source contract: no
// colyseus / StateSchema imports.
// Run: node --test test/simMatchPhases.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WorldState,
  PlayerState,
  OrbState,
  PowerUpState,
  EnemyState,
  ProjectileState,
} from '../src/server/schema/StateSchema.js';
import { pauseGate, resetMatchState } from '../src/shared/sim/matchPhases.js';
import { activateWave, waveEnemyCount, waveEnemyHp } from '../src/shared/waves.js';
import { classStats } from '../src/shared/skills.js';
import { SERVER } from '../src/server/config.js';

/** Fake clock ms anchor — every harness starts here. */
const T0 = 50_000;

/**
 * Bare schema state + plain ctx for pauseGate over a fake clock; records
 * every hook call so tests can pin the auto-pick-before-wall ORDERING and
 * that the win-while-paused hook fires only on walled ticks.
 */
function makeGateHarness({ playerCount = 1, matchState = 'playing' } = {}) {
  const state = new WorldState();
  state.matchState = matchState;
  for (let i = 0; i < playerCount; i++) {
    const p = new PlayerState(0, 0);
    p.name = `p${i}`;
    state.players.set(`sid-${i}`, p);
  }
  let t = T0;
  const order = [];
  const ctx = {
    state,
    players: state.players,
    pendingUntil: new Map(),
    pendingQueue: new Map(),
    pauseBox: { until: 0 },
    intermissionBox: { until: 0 },
    now: () => t,
    checkAutoPicks: () => order.push('autoPick'),
    checkWinWhilePaused: () => order.push('win'),
  };
  return {
    ctx,
    state,
    order,
    player: (i = 0) => state.players.get(`sid-${i}`),
    advance: (ms) => { t += ms; },
    time: () => t,
  };
}

const maxPauseMs = () => SERVER.wave?.maxPauseMs ?? 30000;

// ---------------------------------------------------------------------------
// D7 — pauseGate
// ---------------------------------------------------------------------------

test('pause wall opens only when a player holds pending choices', () => {
  const h = makeGateHarness();
  const res = pauseGate(h.ctx, 0.05);
  assert.deepEqual(
    { dtEff: res.dtEff, paused: res.paused },
    { dtEff: 0.05, paused: false },
    'no pending cards -> world steps normally');
  assert.equal(h.state.paused, false);
  assert.equal(h.ctx.pauseBox.until, 0, 'wall never armed');
  assert.deepEqual(h.order, ['autoPick'], 'auto-pick hook still ran first');

  h.player().pendingChoices.push('vitality', 'scholar', 'swift');
  const res2 = pauseGate(h.ctx, 0.05);
  assert.equal(res2.paused, true, 'any pending card opens the global wall');
  assert.equal(h.state.paused, true);
});

test('walled tick arms maxPauseMs, freezes the step (dtEff 0) and runs the win hook', () => {
  const h = makeGateHarness();
  h.player().pendingChoices.push('a', 'b', 'c');
  const res = pauseGate(h.ctx, 0.05);
  assert.equal(res.dtEff, 0, 'world step skipped while walled');
  assert.equal(res.paused, true);
  assert.equal(h.ctx.pauseBox.until, T0 + maxPauseMs(),
    'wall cap armed once at now + maxPauseMs');
  assert.deepEqual(h.order, ['autoPick', 'win'],
    'win-while-paused hook fired on the walled tick, after auto-pick');
});

test('auto-pick fires BEFORE the wall scan (ordering contract)', () => {
  const h = makeGateHarness();
  // The stub simulates a deadline expiring exactly now: the pick resolves and
  // the cards vanish BEFORE the gate scans pending choices.
  h.player().pendingChoices.push('a', 'b', 'c');
  h.ctx.checkAutoPicks = () => {
    h.order.push('autoPick');
    h.player().pendingChoices.pop();
    h.player().pendingChoices.pop();
    h.player().pendingChoices.pop();
  };
  const res = pauseGate(h.ctx, 0.05);
  assert.equal(res.paused, false,
    'pausing the sim must NOT stall the pick: resolved picks never open the wall');
  assert.equal(h.state.paused, false);
  assert.deepEqual(h.order, ['autoPick'], 'win hook NOT called on a free tick');
});

test('walled tick extends an active intermission deadline by dt*1000', () => {
  const h = makeGateHarness({ matchState: 'intermission' });
  h.ctx.intermissionBox.until = T0 + 8000;
  h.player().pendingChoices.push('a', 'b', 'c');
  pauseGate(h.ctx, 0.5);
  assert.equal(h.ctx.intermissionBox.until, T0 + 8000 + 500,
    'intermission deadline pushed by the walled dt');
  assert.equal(h.state.intermissionUntil, T0 + 8500,
    'schema mirror kept in sync with the live deadline');
});

test('deadline extension only applies during an armed intermission', () => {
  const hPlaying = makeGateHarness({ matchState: 'playing' });
  hPlaying.ctx.intermissionBox.until = T0 + 8000;
  hPlaying.player().pendingChoices.push('a', 'b', 'c');
  pauseGate(hPlaying.ctx, 0.5);
  assert.equal(hPlaying.ctx.intermissionBox.until, T0 + 8000,
    'playing phase: deadline untouched');

  const hUnarmed = makeGateHarness({ matchState: 'intermission' });
  hUnarmed.player().pendingChoices.push('a', 'b', 'c');
  pauseGate(hUnarmed.ctx, 0.5);
  assert.equal(hUnarmed.ctx.intermissionBox.until, 0,
    'until=0 means no live intermission: nothing to extend');
});

test('maxPauseMs release opens the wall without re-arming while picks stay open', () => {
  const h = makeGateHarness();
  h.player().pendingChoices.push('a', 'b', 'c');
  pauseGate(h.ctx, 0.05); // arm at T0 + maxPauseMs
  h.order.length = 0; // only judge hooks fired from here on
  h.advance(maxPauseMs() + 1);

  const released = pauseGate(h.ctx, 0.05);
  assert.equal(released.paused, true, 'raw scan still sees the open card');
  assert.equal(h.state.paused, false, 'cap expiry reopens the world');
  assert.equal(released.dtEff, 0.05, 'world step resumes');
  assert.equal(h.ctx.pauseBox.until, T0 + maxPauseMs(),
    'armed cap is NOT refreshed on release ticks');
  assert.deepEqual(h.order, ['autoPick'], 'release tick is not a walled tick');

  // Still-open cards on later ticks keep hitting the stale cap -> stay open.
  h.advance(100);
  const stillOpen = pauseGate(h.ctx, 0.05);
  assert.equal(stillOpen.paused, true);
  assert.equal(stillOpen.dtEff, 0.05, 'released wall stays released');

  // Once every card resolves, the next free tick disarms the box entirely.
  h.player().pendingChoices.pop();
  h.player().pendingChoices.pop();
  h.player().pendingChoices.pop();
  pauseGate(h.ctx, 0.05);
  assert.equal(h.ctx.pauseBox.until, 0, 'disarmed when nothing is pending');
});

test('multi-player rooms pause on ANY pending card (GameRoom scan rule)', () => {
  const h = makeGateHarness({ playerCount: 3 });
  pauseGate(h.ctx, 0.05);
  assert.equal(h.state.paused, false);
  h.player(2).pendingChoices.push('only');
  const res = pauseGate(h.ctx, 0.05);
  assert.equal(res.paused, true, 'one stalled card freezes the whole room');
});

// ---------------------------------------------------------------------------
// D8 — resetMatchState
// ---------------------------------------------------------------------------

/** Bare schema state polluted with mid-match junk + recording hooks. */
function makeResetHarness({ players = ['sid-a', 'sid-b'] } = {}) {
  const state = new WorldState();
  const calls = [];
  for (const sid of players) {
    const p = new PlayerState(3, -7);
    p.name = sid;
    p.character = 2;
    p.hp = 5;
    p.score = 123;
    p.anim = 'attack';
    p.blocking = true;
    p.attackCd = 40;
    p.skillCd = 900;
    p.effects.set('speed', 1000);
    p.level = 6;
    p.xp = 240;
    p.pendingChoices.push('x', 'y', 'z');
    p.upgrades.set('vitality', 3);
    state.players.set(sid, p);
  }
  state.winnerId = 'sid-a';
  state.winnerName = 'sid-a';
  state.projectiles.push(new ProjectileState(1, 'sid-a', 'arrow', 0, 0, 1, 0));
  // A fresh WorldState spawns empty collections — rooms seed orbs/power-ups
  // themselves (spawnOrbs/spawnPowerUps), so the harness mirrors that.
  for (let i = 0; i < SERVER.orb.count; i++) state.orbs.push(new OrbState(1, 1));
  const puTypes = ['speed', 'shield', 'double'];
  for (let i = 0; i < SERVER.powerUps.count; i++) {
    state.powerUps.push(new PowerUpState(2, 2, puTypes[i % puTypes.length]));
  }

  let seq = 0;
  const positions = [];
  const samplePos = (kind) => {
    seq += 1;
    positions.push(kind);
    return kind === 'player'
      ? { x: 10 + seq, z: -10 - seq }
      : { x: seq * 2, z: seq * 3 };
  };
  const ctx = {
    state,
    pendingUntil: new Map([['sid-a', T0], ['sid-b', T0]]),
    pendingQueue: new Map([['sid-b', [4]]]),
    spawnWave: (n) => calls.push(['spawnWave', n]),
  };
  const opts = {
    samplePos,
    onResetPlayerScratch: (sid) => calls.push(['scratch', sid]),
    onResetTransient: () => calls.push(['transient']),
    onResetPowerUps: () => calls.push(['powerUpTimers']),
  };
  return { ctx, opts, state, calls, positions, samplePos };
}

test('reset restores players to base stats at sampler positions', () => {
  const h = makeResetHarness();
  resetMatchState(h.ctx, h.opts);
  for (const p of h.state.players.values()) {
    assert.equal(p.hp, classStats(p.character).hp, 'base per-class HP restored');
    assert.equal(p.score, 0);
    assert.equal(p.anim, 'idle');
    assert.equal(p.blocking, false);
    assert.equal(p.attackCd, 0);
    assert.equal(p.skillCd, 0);
    assert.equal(p.effects.size, 0, 'buffs never carry into the next match');
    assert.equal(p.level, 1);
    assert.equal(p.xp, 0);
    assert.equal(p.pendingChoices.length, 0);
    assert.equal(p.upgrades.size, 0);
  }
  const [a, b] = [...h.state.players.values()];
  assert.deepEqual([a.x, a.z], [11, -11], 'player placed by the injected sampler');
  assert.deepEqual([b.x, b.z], [12, -12]);
});

test('rotY only changes when the sampler provides it (GR parity)', () => {
  const h = makeResetHarness();
  [...h.state.players.values()].forEach((p) => { p.rotY = Math.PI; });
  resetMatchState(h.ctx, h.opts);
  for (const p of h.state.players.values()) {
    assert.equal(p.rotY, Math.PI, 'sampler without rotY leaves facing alone');
  }

  const h2 = makeResetHarness();
  [...h2.state.players.values()].forEach((p) => { p.rotY = Math.PI; });
  const origSample = h2.opts.samplePos;
  h2.opts.samplePos = (kind) => ({ ...origSample(kind), rotY: 0 });
  resetMatchState(h2.ctx, h2.opts);
  for (const p of h2.state.players.values()) {
    assert.equal(p.rotY, 0, 'LR origin-style sampler resets facing via rotY');
  }
});

test('reset clears scratch maps per sid and fires room-side scratch hooks', () => {
  const h = makeResetHarness();
  resetMatchState(h.ctx, h.opts);
  assert.equal(h.ctx.pendingUntil.size, 0, 'auto-pick deadlines die with the match');
  assert.equal(h.ctx.pendingQueue.size, 0, 'queued reveals die with the match');
  assert.deepEqual(
    h.calls.filter(([k]) => k === 'scratch').map(([, sid]) => sid).sort(),
    ['sid-a', 'sid-b'],
    'onResetPlayerScratch fired once per living seat');
});

test('winner cleared; projectiles cleared on BOTH sides (sanctioned alignment #2)', () => {
  const h = makeResetHarness();
  resetMatchState(h.ctx, h.opts);
  assert.equal(h.state.winnerId, '');
  assert.equal(h.state.winnerName, '');
  assert.equal(h.state.projectiles.length, 0,
    'alignment #2: stale projectiles cannot resume flying in the new match');

  const h2 = makeResetHarness();
  resetMatchState(h2.ctx, { ...h2.opts, resetProjectiles: false });
  assert.equal(h2.state.projectiles.length, 1,
    'explicit opt-out keeps the clear off (escape hatch, unused by both rooms)');
});

test('orbs and power-ups reseeded; power-up bookkeeping hook fired', () => {
  const h = makeResetHarness();
  h.state.orbs[0].x = 99;
  h.state.powerUps[0].active = false;
  resetMatchState(h.ctx, h.opts);
  assert.notEqual(h.state.orbs[0].x, 99, 'orb moved by the sampler');
  assert.ok(h.state.powerUps.every((pu) => pu.active),
    'every power-up back in play');
  assert.deepEqual(
    h.calls.filter(([k]) => k === 'powerUpTimers').length, 1,
    'onResetPowerUps fired exactly once (GR clears powerUpTimers there)');
});

test('wave 1 activation ordered after transient-buffer clear', () => {
  const h = makeResetHarness();
  resetMatchState(h.ctx, h.opts);
  const keys = h.calls.map(([k]) => k);
  assert.ok(keys.includes('transient'), 'transient hook ran');
  assert.deepEqual(h.calls.find(([k]) => k === 'spawnWave'),
    ['spawnWave', 1], 'fresh match reactivates wave 1');
  assert.ok(keys.indexOf('transient') < keys.indexOf('spawnWave'),
    'melee buffers drop before the wave spawns');
});

test('samplePos receives placement kinds for players, orbs and power-ups', () => {
  const h = makeResetHarness();
  resetMatchState(h.ctx, h.opts);
  const kinds = {};
  for (const k of h.positions) kinds[k] = (kinds[k] || 0) + 1;
  assert.equal(kinds.player, 2);
  assert.equal(kinds.orb, SERVER.orb.count);
  assert.equal(kinds.powerup, SERVER.powerUps.count);
});

// ---------------------------------------------------------------------------
// Stretch D1 — activateWave (src/shared/waves.js)
// ---------------------------------------------------------------------------

test('activateWave revives count slots at wave hp, rest dead, anim idle', () => {
  const enemies = [];
  for (let i = 0; i < SERVER.enemy.pool; i++) enemies.push(new EnemyState(0, 0));
  enemies.forEach((e) => { e.hp = 999; e.anim = 'attack'; }); // pre-pollute
  const players = new Map();
  const me = new PlayerState(-20, -20); // far corner: any spawn is "away"
  players.set('me', me);

  const n = 3;
  const res = activateWave(enemies, n, players, () => ({ x: 15, z: 15 }),
    () => {});
  assert.deepEqual(res, { count: waveEnemyCount(n), hp: waveEnemyHp(n) });
  enemies.forEach((e, i) => {
    if (i < waveEnemyCount(n)) {
      assert.equal(e.hp, waveEnemyHp(n), `slot ${i} alive at wave hp`);
      assert.equal(e.anim, 'idle', `slot ${i} plays idle`);
      assert.deepEqual([e.x, e.z], [15, 15], `slot ${i} placed by the sampler`);
    } else {
      assert.equal(e.hp, 0, `slot ${i} beyond the count stays dead`);
    }
  });
});

test('activateWave spawns away from living players via the injected sampler', () => {
  const enemies = [];
  for (let i = 0; i < SERVER.enemy.pool; i++) enemies.push(new EnemyState(0, 0));
  const players = new Map();
  players.set('me', new PlayerState(0, 0)); // alive
  const corpse = new PlayerState(5, 5);
  corpse.hp = 0;
  players.set('ghost', corpse); // dead players are not spawn hazards

  let samples = 0;
  activateWave(enemies, 2, players, () => {
    samples += 1;
    return { x: 30, z: 30 }; // > minDist(12) away: first sample accepted
  }, () => {});
  assert.ok(enemies[0].hp > 0 && enemies[1].hp > 0);
  assert.deepEqual([enemies[0].x, enemies[0].z], [30, 30],
    'accepted sample wins immediately (spawnAwayFromPlayers best-of-8)');
  assert.equal(samples, waveEnemyCount(2),
    'sampler consulted exactly once per alive slot when minDist holds');
});

test('activateWave fires onSlotReset once per slot before placement', () => {
  const enemies = [];
  for (let i = 0; i < SERVER.enemy.pool; i++) enemies.push(new EnemyState(0, 0));
  const cleared = [];
  activateWave(enemies, 1, new Map(), () => ({ x: 0, z: 0 }),
    (enemy) => cleared.push(enemy));
  assert.equal(cleared.length, SERVER.enemy.pool,
    'rooms clear their anim/stun map entries keyed per enemy here');
  assert.deepEqual(cleared, enemies, 'same slot objects, in pool order');
});

test('activateWave accepts array or Map-like player containers', () => {
  const enemies = [new EnemyState(0, 0), new EnemyState(0, 0)];
  const asArray = [new PlayerState(-20, -20)];
  const res = activateWave(enemies, 1, asArray, () => ({ x: 1, z: 1 }), () => {});
  assert.equal(res.count, waveEnemyCount(1));
});

// ---------------------------------------------------------------------------
// Source contract — src/shared/sim/*.js imports no colyseus / StateSchema
// ---------------------------------------------------------------------------

test('source contract: src/shared/sim/*.js imports no colyseus or StateSchema', () => {
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'shared', 'sim');
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]colyseus['"]/, `${f}: no colyseus import`);
    assert.doesNotMatch(src, /StateSchema/, `${f}: no StateSchema import`);
  }
});

// ---------------------------------------------------------------------------
// Integration parity — post-playAgain projectiles are empty on BOTH sides
// (the sanctioned alignment #2 pinned end to end; real boot, poll-driven).
// Top-level script style like waves.test.mjs: a Colyseus boot keeps handles
// open, so this file terminates with an explicit exit after asserting.
// ---------------------------------------------------------------------------
{
  const http = await import('node:http');
  const { Server, WebSocketTransport } = await import('colyseus');
  const { Client } = await import('@colyseus/sdk');
  const GameRoom = (await import('../src/server/rooms/GameRoom.js')).default;
  const { buildHttpApp } = await import('../src/server/http.js');
  const { resetRateLimit } = await import('../src/server/ratelimit.js');
  const { LocalRoom } = await import('../src/LocalRoom.js');
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
    express: (app) => buildHttpApp(app),
  });
  gameServer.define('game', GameRoom);
  await gameServer.listen(0);
  try {
    const port = httpServer.address().port;
    const c = new Client(`ws://localhost:${port}`);
    const r = await c.create('game', { name: 'Reset' }, WorldState);
    const sr = [...GameRoom.instances].find((x) => x.roomId === r.roomId);
    await waitFor(() => sr?.state?.matchState === 'playing', 5000, 'playing');

    // A firewave mid-flight would otherwise resume flying across the reset
    // (the latent GR bug alignment #2 fixes).
    sr.state.projectiles.push(new ProjectileState(77, r.sessionId, 'fireball', 0, 0, 1, 0));
    assert.equal(sr.state.projectiles.length, 1);
    sr.state.players.get(r.sessionId).score = SERVER.match.targetScore;
    await waitFor(() => sr.state.matchState === 'gameover', 3000, 'gameover');
    r.send('playAgain');
    await waitFor(() => sr.state.matchState === 'countdown', 3000, 'countdown');
    assert.equal(sr.state.projectiles.length, 0,
      'SERVER: playAgain clears live projectiles (alignment #2)');
    r.leave();
    await waitMs(100);
  } finally {
    await gameServer.gracefullyShutdown(false);
    httpServer.closeAllConnections();
    await new Promise((res) => httpServer.close(res));
    resetRateLimit();
  }

  // LOCAL parity: same invariant through _resetMatch.
  const room = new LocalRoom();
  await room.join('Solo', 0);
  room._running = false;
  room._countdownTimer = 0;
  room._step(0.05);
  room.state.projectiles.push(new ProjectileState(78, room.sessionId, 'fireball', 0, 0, 1, 0));
  room._endMatch(room.state.players.get(room.sessionId));
  assert.equal(room.state.matchState, 'gameover');
  room.send('playAgain');
  assert.equal(room.state.matchState, 'countdown', 'LOCAL: reset gated on gameover works');
  assert.equal(room.state.projectiles.length, 0,
    'LOCAL: reset clears live projectiles');
  const me = room.state.players.get(room.sessionId);
  assert.deepEqual([me.x, me.z, me.rotY], [0, 0, 0], 'LOCAL: player back at origin');
  assert.equal(room.state.wave, 1, 'LOCAL: back to wave 1');
  assert.equal(me.level, 1, 'LOCAL: level reset');
  assert.equal(me.score, 0, 'LOCAL: score reset');
  room.leave();
}

console.log('ok — simMatchPhases.test.mjs: pause wall (auto-pick ordering, maxPauseMs cap/release, intermission extension), match reset parity incl. sanctioned projectile-clear alignment, stretch activateWave');
process.exit(0);
