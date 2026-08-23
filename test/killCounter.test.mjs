// Kill counter (FR-GAME-03): per-player kills credited through the shared
// combatBook kill paths and surfaced on the share card.
// Run: node --test test/killCounter.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorldState, PlayerState, EnemyState } from '../src/server/schema/StateSchema.js';
import { resolveEnemyHit, tickBurns } from '../src/shared/sim/combatBook.js';
import { buildShareCard, shareText } from '../src/shared/sim/shareCard.js';
import { SERVER } from '../src/server/config.js';
import { effectiveMaxHp } from '../src/shared/progression.js';

function makeHarness() {
  const state = new WorldState();
  state.wave = 1;
  state.matchState = 'playing';
  const player = new PlayerState(10, 10);
  player.name = 'Tester';
  player.hp = effectiveMaxHp(0, player.upgrades);
  state.players.set('sid-1', player);
  const ctx = {
    state,
    half: SERVER.world.size / 2,
    players: state.players,
    enemyAnimUntil: new Map(),
    enemyStunUntil: new Map(),
    burnByProjId: new Map(),
    activeBurns: new Map(),
    now: () => 50_000,
    log: () => {},
  };
  return { ctx, player };
}

function makeEnemy(hp = 1) {
  const e = new EnemyState(0, 0);
  e.hp = hp;
  return e;
}

test('direct kill increments killer.kills; survivor hit does not', () => {
  const { ctx, player } = makeHarness();
  assert.equal(player.kills ?? 0, 0); // schema exposes the field at 0
  const dead = resolveEnemyHit(ctx, makeEnemy(1), 10, 9, 9, 'sid-1');
  assert.equal(dead.killed, true);
  assert.equal(player.kills, 1);
  const alive = resolveEnemyHit(ctx, makeEnemy(100), 10, 9, 9, 'sid-1');
  assert.equal(alive.killed, false);
  assert.equal(player.kills, 1);
});

test('fatal sourced burn tick credits kills like a direct kill', () => {
  const { ctx, player } = makeHarness();
  const enemy = makeEnemy(2);
  // register a sourced burn via the same shape tickBurns consumes
  ctx.activeBurns.set(enemy, { damage: 5, tickMs: 100, durationMs: 500, lastTickMs: 49_900, remainingMs: 500, killerSid: 'sid-1' });
  tickBurns(ctx, 50_000);
  assert.equal(enemy.hp, 0);
  assert.equal(player.kills, 1);
});

test('unattributed kills (killerSid null) credit nobody', () => {
  const { ctx } = makeHarness();
  resolveEnemyHit(ctx, makeEnemy(1), 10, 9, 9, null);
  for (const p of ctx.players.values()) assert.equal(p.kills ?? 0, 0);
});

test('share card carries Kills only when provided; text includes it once', () => {
  const withKills = buildShareCard({ mode: 'waves', wave: 3, score: 120, kills: 7 });
  assert.ok(withKills.stats.some((s) => s.label === 'Kills' && s.value === 7));
  const without = buildShareCard({ mode: 'waves', wave: 3, score: 120 });
  assert.ok(!without.stats.some((s) => s.label === 'Kills'));
  assert.equal(shareText(withKills).split('7').length - 1, 1);
});
