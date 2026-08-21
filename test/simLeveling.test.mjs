// P1.3 Slice 1 — Layer A unit tests for src/shared/sim/leveling.js (D2).
// Pins the extracted contract independently of either room: bare WorldState +
// plain ctx with a fake clock, so no sockets are needed. Also guards the
// shared-sim source contract: no colyseus / StateSchema imports allowed there.
// Run: node --test test/simLeveling.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorldState, PlayerState } from '../src/server/schema/StateSchema.js';
import {
  hashSeed,
  grantXp,
  maybeLevelUp,
  showNextQueued,
  applyUpgrade,
  checkAutoPicks,
  chooseUpgrade,
} from '../src/shared/sim/leveling.js';
import { rollUpgrades, getUpgrade, effectiveMaxHp, AUTO_PICK_MS } from '../src/shared/progression.js';
import { SERVER } from '../src/server/config.js';

const autoPickMs = () => SERVER.progression?.autoPickMs ?? AUTO_PICK_MS;

/** Bare schema state + plain ctx over a fake clock; records all hook traffic. */
function makeHarness({ character = 1 } = {}) {
  const state = new WorldState();
  const player = new PlayerState(0, 0);
  player.name = 'Tester';
  player.character = character;
  player.hp = 100;
  player.level = 1;
  player.xp = 0;
  state.players.set('sid-1', player);

  let t = 10_000; // fake clock ms
  const events = [];
  const messages = [];
  const warnings = [];
  const ctx = {
    players: state.players,
    pendingUntil: new Map(),
    pendingQueue: new Map(),
    now: () => t,
    emit: (sid, type, data) => messages.push({ sid, type, data }),
    log: (event, fields) => events.push({ event, fields }),
    warn: (event, fields) => warnings.push({ event, fields }),
  };
  return {
    ctx,
    state,
    player,
    events,
    messages,
    warnings,
    advance: (ms) => { t += ms; },
    time: () => t,
    logNames: () => events.map((e) => e.event),
    msgTypes: () => messages.map((m) => m.type),
    picksOf: () => [...player.pendingChoices],
  };
}

test('hashSeed is deterministic per (sid, level), never collapses to 0', () => {
  assert.equal(hashSeed('alice', 2), hashSeed('alice', 2));
  assert.notEqual(hashSeed('alice', 2), hashSeed('alice', 3));
  assert.notEqual(hashSeed('alice', 2), hashSeed('bob', 2));
  // h||1 guard keeps rollUpgrades' makeRng(seed) deterministic even if a
  // future seed form ever hashed to 0
  assert.equal(typeof hashSeed('x', 1), 'number');
  assert.notEqual(hashSeed('x', 1), 0);
});

test('grantXp applies the scholar bonus via effectiveXp before leveling', () => {
  const h = makeHarness();
  h.player.upgrades.set('scholar', 1); // +20% XP
  grantXp(h.ctx, 'sid-1', 20);
  assert.equal(h.player.xp, 24, '20 base -> 24 after scholar +20%');
  assert.ok(h.logNames().includes('xp_gain'), 'xp_gain logged');
  const evt = h.events.find((e) => e.event === 'xp_gain');
  assert.deepEqual(evt.fields, { sid: 'sid-1', amount: 24, total: 24 });
});

test('grantXp is a no-op for unknown sid or non-positive amounts', () => {
  const h = makeHarness();
  grantXp(h.ctx, 'nobody', 100);
  grantXp(h.ctx, 'sid-1', 0);
  assert.equal(h.player.xp, 0);
  assert.equal(h.player.level, 1);
  assert.equal(h.logNames().length, 0);
});

test('level up at threshold shows exactly the seeded 3 cards + deadline + message', () => {
  const h = makeHarness();
  grantXp(h.ctx, 'sid-1', 100); // exactly level 2
  assert.equal(h.player.level, 2);
  assert.equal(h.player.xp, 100);
  assert.equal(h.picksOf().length, 3);
  assert.equal(new Set(h.picksOf()).size, 3, 'choices distinct');
  const expected = rollUpgrades(hashSeed('sid-1', 2), h.player.character, new Map());
  assert.deepEqual(h.picksOf(), expected, 'cards equal seeded rollUpgrades(sid,level)');
  assert.equal(h.ctx.pendingUntil.get('sid-1'), h.time() + autoPickMs(),
    'auto-pick deadline = now + configured ms on the fake clock');
  assert.deepEqual(h.msgTypes(), ['levelUp']);
  assert.deepEqual(h.messages[0].data, { level: 2, choices: expected });
});

test('multi-level burst queues later levels: first pick reveals the queued seed', () => {
  const h = makeHarness();
  grantXp(h.ctx, 'sid-1', 250); // enough for levels 2 AND 3
  assert.equal(h.player.level, 3, 'level already reflects every queued gain');
  assert.deepEqual([...h.ctx.pendingQueue.get('sid-1')], [3], 'level 3 queued');
  assert.deepEqual(h.picksOf(), rollUpgrades(hashSeed('sid-1', 2), h.player.character, new Map()),
    'only the first level cards show');

  // Manual pick of the first card chains into the queued reveal
  const firstPick = h.picksOf()[0];
  assert.equal(chooseUpgrade(h.ctx, 'sid-1', firstPick), 'ok');
  assert.deepEqual(h.picksOf(), rollUpgrades(hashSeed('sid-1', 3), h.player.character, new Map()),
    'queued level 3 cards revealed after the pick');
  assert.equal(h.ctx.pendingUntil.get('sid-1'), h.time() + autoPickMs(),
    'deadline refreshed for the queued cards');
  assert.deepEqual(h.msgTypes(), ['levelUp', 'upgradeResult', 'levelUp']);

  const secondPick = h.picksOf()[0];
  assert.equal(chooseUpgrade(h.ctx, 'sid-1', secondPick), 'ok');
  assert.equal(h.picksOf().length, 0);
  const stacks = [...h.player.upgrades.entries()].reduce((s, [, n]) => s + n, 0);
  assert.equal(stacks, 2, 'two picks applied across two levels');
  assert.equal(h.ctx.pendingQueue.get('sid-1').length, 0, 'queue drained');
});

test('maybeLevelUp with sub-threshold xp does nothing', () => {
  const h = makeHarness();
  grantXp(h.ctx, 'sid-1', 99);
  assert.equal(h.player.level, 1);
  assert.equal(h.picksOf().length, 0);
  assert.equal(h.messages.length, 0);
  assert.equal(h.ctx.pendingUntil.has('sid-1'), false);
});

test('checkAutoPicks fires only once the injected fake clock passes the deadline', () => {
  const h = makeHarness();
  grantXp(h.ctx, 'sid-1', 100);
  const auto = h.picksOf()[0];

  h.advance(autoPickMs() - 1);
  checkAutoPicks(h.ctx);
  assert.equal(h.picksOf().length, 3, 'not yet due: cards still pending');
  assert.equal(h.player.upgrades.size, 0);

  h.advance(1);
  checkAutoPicks(h.ctx);
  assert.equal(h.picksOf().length, 0, 'deadline passed: auto-picked');
  assert.equal(h.player.upgrades.get(auto), 1, `first card ${auto} recorded`);
  assert.equal(h.ctx.pendingUntil.has('sid-1'), false, 'deadline entry consumed');
  assert.deepEqual(h.msgTypes(), ['levelUp', 'upgradeResult']);
  const result = h.messages.find((m) => m.type === 'upgradeResult');
  assert.deepEqual(result.data, { picked: auto, auto: true });
  assert.ok(h.logNames().includes('upgrade_auto_pick'));
});

test('checkAutoPicks chains queued reveals after an auto-pick', () => {
  const h = makeHarness();
  grantXp(h.ctx, 'sid-1', 250); // queue holds level 3
  h.advance(autoPickMs() + 1);
  checkAutoPicks(h.ctx);
  assert.deepEqual(h.picksOf(), rollUpgrades(hashSeed('sid-1', 3), h.player.character, new Map()),
    'queued level 3 cards shown right after the auto-pick');
  assert.equal(h.ctx.pendingUntil.get('sid-1'), h.time() + autoPickMs());
  assert.deepEqual(h.msgTypes(), ['levelUp', 'upgradeResult', 'levelUp']);
});

test('checkAutoPicks garbage-collects stale deadlines (no choices / unknown sid)', () => {
  const h = makeHarness();
  h.ctx.pendingUntil.set('sid-1', h.time() - 5); // player exists, no cards
  h.ctx.pendingUntil.set('ghost', h.time() - 5); // player gone
  checkAutoPicks(h.ctx);
  assert.equal(h.ctx.pendingUntil.size, 0, 'stale entries deleted');
  assert.equal(h.messages.length, 0);
});

test('applyUpgrade: vitality heals +30 clamped to effectiveMaxHp via effective helpers', () => {
  const h = makeHarness({ character: 0 }); // knight
  h.player.hp = 50;
  assert.equal(applyUpgrade(h.ctx, 'sid-1', 'vitality'), true);
  assert.equal(h.player.upgrades.get('vitality'), 1);
  assert.equal(h.player.hp, Math.min(effectiveMaxHp(0, h.player.upgrades), 80),
    'heal is +30 clamped to the upgraded max HP');
  assert.ok(h.logNames().includes('upgrade_pick'));

  // Already at/above max: clamp pins to max
  h.player.hp = 9999;
  applyUpgrade(h.ctx, 'sid-1', 'vitality');
  assert.equal(h.player.hp, effectiveMaxHp(0, h.player.upgrades));
});

test('applyUpgrade rejects unknown ids and enforces maxStacks', () => {
  const h = makeHarness();
  assert.equal(applyUpgrade(h.ctx, 'sid-1', 'not_a_card'), false);
  assert.equal(h.player.upgrades.size, 0);

  h.player.upgrades.set('swift', 3); // swift maxStacks = 3
  assert.equal(applyUpgrade(h.ctx, 'sid-1', 'swift'), false, 'stack guard blocks');
  assert.equal(h.player.upgrades.get('swift'), 3, 'count unchanged');
});

test('chooseUpgrade return codes: no_pending / not_offered keep state intact', () => {
  const h = makeHarness();
  assert.equal(chooseUpgrade(h.ctx, 'sid-1', 'vitality'), 'no_pending');
  assert.ok(h.warnings.some((w) => w.fields.reason === 'no_pending'),
    'no_pending warned');

  grantXp(h.ctx, 'sid-1', 100);
  const deadline = h.ctx.pendingUntil.get('sid-1');
  assert.equal(chooseUpgrade(h.ctx, 'sid-1', 'nonexistent'), 'not_offered');
  assert.ok(h.warnings.some((w) => w.fields.reason === 'not_offered'));
  assert.equal(h.picksOf().length, 3, 'invalid pick keeps pending');
  assert.equal(h.ctx.pendingUntil.get('sid-1'), deadline, 'deadline untouched');
});

test('chooseUpgrade ok path clears pendingChoices, deadline, and emits manual result', () => {
  const h = makeHarness();
  grantXp(h.ctx, 'sid-1', 100);
  const choice = h.picksOf()[0];
  assert.equal(chooseUpgrade(h.ctx, 'sid-1', choice), 'ok');
  assert.equal(h.picksOf().length, 0, 'pendingChoices cleared');
  assert.equal(h.ctx.pendingUntil.has('sid-1'), false, 'deadline cleared');
  assert.equal(h.player.upgrades.get(choice), 1);
  const result = h.messages.find((m) => m.type === 'upgradeResult');
  assert.deepEqual(result.data, { picked: choice, auto: false });
  assert.ok(h.logNames().includes('upgrade_pick'));
});

test('chooseUpgrade surfaces apply_failed when the offered card hits maxStacks', () => {
  const h = makeHarness();
  grantXp(h.ctx, 'sid-1', 100);
  // The first seeded offer is genuinely pending; saturate its stacks
  // out-of-band so the apply guard must reject it.
  const target = h.picksOf()[0];
  const def = getUpgrade(target);
  h.player.upgrades.set(target, def.maxStacks ?? 99);
  assert.equal(chooseUpgrade(h.ctx, 'sid-1', target), 'apply_failed');
  assert.ok(h.warnings.some((w) => w.fields.reason === 'apply_failed'));
  assert.equal(h.player.upgrades.get(target), def.maxStacks ?? 99,
    'no extra stack applied');
});

test('showNextQueued with no queue entry is a silent no-op', () => {
  const h = makeHarness();
  showNextQueued(h.ctx, 'sid-1');
  maybeLevelUp(h.ctx, 'ghost'); // unknown player too
  assert.equal(h.messages.length, 0);
  assert.equal(h.logNames().length, 0);
});

test('source contract: src/shared/sim/*.js imports no colyseus or StateSchema', () => {
  const dir = fileURLToPath(new URL('../src/shared/sim/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('leveling.js'), 'leveling.js exists under src/shared/sim/');
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]colyseus['"]/, `${f}: no colyseus import`);
    assert.doesNotMatch(src, /StateSchema/, `${f}: no StateSchema import`);
  }
});
