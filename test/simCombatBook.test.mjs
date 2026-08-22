// P1.3 Slice 2 — Layer A unit tests for src/shared/sim/combatBook.js (D5
// enemy-hit resolution + D4 burn DoT) and src/shared/sim/shopEffects.js (D3).
// Pins the extracted contracts independently of either room: bare WorldState +
// plain ctx over a fake clock, so no sockets are needed. Also guards the
// shared-sim source contract: no colyseus / StateSchema imports allowed there.
// Run: node --test test/simCombatBook.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorldState, PlayerState, EnemyState, ProjectileState } from '../src/server/schema/StateSchema.js';
import {
  resolveEnemyHit,
  registerProjBurn,
  startBurnFromProjectile,
  tickBurns,
  knockbackAgainst,
} from '../src/shared/sim/combatBook.js';
import { applyShopChoice } from '../src/shared/sim/shopEffects.js';
import { getUpgrade, effectiveMaxHp } from '../src/shared/progression.js';
import { SERVER } from '../src/server/config.js';

const BURN_DEF = { damage: 3, durationMs: 500, tickMs: 100 };

/**
 * Bare schema state + plain ctx over a fake clock; records all hook traffic.
 * Mirrors the simLeveling.test.mjs harness so both slice test files read the
 * same way. `grantXp` is a recording hook — the rooms wire it to
 * leveling.grantXp; here we only pin that the module calls it correctly.
 */
function makeHarness({ character = 0, wave = 4 } = {}) {
  const state = new WorldState();
  state.wave = wave;
  state.matchState = 'playing';
  const player = new PlayerState(10, 10);
  player.name = 'Tester';
  player.character = character;
  player.hp = effectiveMaxHp(character, player.upgrades);
  player.score = 0;
  player.level = 1;
  player.xp = 0;
  state.players.set('sid-1', player);

  let t = 50_000; // fake clock ms
  const events = [];
  const messages = [];
  const warnings = [];
  const xpGrants = [];
  const ctx = {
    state,
    half: SERVER.world.size / 2,
    players: state.players,
    enemyAnimUntil: new Map(),
    enemyStunUntil: new Map(),
    burnByProjId: new Map(),
    activeBurns: new Map(),
    shopChoices: new Map(),
    now: () => t,
    grantXp: (sid, amount) => xpGrants.push({ sid, amount }),
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
    xpGrants,
    advance: (ms) => { t += ms; },
    time: () => t,
    logNames: () => events.map((e) => e.event),
    msgTypes: () => messages.map((m) => m.type),
  };
}

/** A living enemy at (20, 20) with the given HP. */
function makeEnemy(hp = 10) {
  const enemy = new EnemyState(20, 20);
  enemy.hp = hp;
  return enemy;
}

// ---------------------------------------------------------------------------
// D5 — resolveEnemyHit
// ---------------------------------------------------------------------------

test('resolveEnemyHit kill path: score + XP via hooks, dead-stays-dead', () => {
  const h = makeHarness();
  const enemy = makeEnemy(5);
  const result = resolveEnemyHit(h.ctx, enemy, 5, 18, 18, 'sid-1');
  assert.deepEqual(result, { hit: true, killed: true });
  assert.equal(enemy.hp, 0, 'enemy stays dead at 0 hp');
  assert.equal(h.player.score, SERVER.enemy.killScore, 'killScore awarded to killer');
  assert.deepEqual(h.xpGrants, [{ sid: 'sid-1', amount: SERVER.progression?.xpPerKill ?? 30 }],
    'exactly one xpPerKill grant for the killer sid');
  assert.ok(h.logNames().includes('enemy_killed'), 'enemy_killed logged');
  const evt = h.events.find((e) => e.event === 'enemy_killed');
  assert.equal(evt.fields.wave, h.state.wave);
  assert.equal(evt.fields.by, 'Tester');
  assert.equal(h.ctx.enemyStunUntil.size, 0, 'no hit-stun on a corpse');
});

test('resolveEnemyHit survive path: knockback + anim=hit + stun windows, no score/xp', () => {
  const h = makeHarness();
  const enemy = makeEnemy(100);
  const startX = enemy.x;
  const result = resolveEnemyHit(h.ctx, enemy, 10, 15, 15, 'sid-1');
  assert.deepEqual(result, { hit: true, killed: false });
  assert.equal(enemy.hp, 90, 'damage applied');
  assert.notEqual(enemy.x, startX, 'knockback pushed the enemy away from the source');
  assert.equal(enemy.anim, 'hit', 'hit react anim set on survivors');
  assert.equal(h.ctx.enemyAnimUntil.get(enemy), h.time() + SERVER.enemy.hitAnimMs,
    'anim override window armed on the fake clock');
  assert.equal(h.ctx.enemyStunUntil.get(enemy), h.time() + SERVER.enemy.hitStunMs,
    'hit-stun window armed on the fake clock');
  assert.equal(h.player.score, 0, 'no score without a kill');
  assert.deepEqual(h.xpGrants, [], 'no XP without a kill');
  assert.deepEqual(h.logNames(), [], 'no kill log without a kill');
});

test('resolveEnemyHit survivor stun uses stunOverrideMs when given (future D9 seam)', () => {
  const h = makeHarness();
  const enemy = makeEnemy(100);
  resolveEnemyHit(h.ctx, enemy, 1, 19, 19, null, 1234);
  assert.equal(h.ctx.enemyStunUntil.get(enemy), h.time() + 1234, 'override replaces hitStunMs');
  assert.equal(h.ctx.enemyAnimUntil.get(enemy), h.time() + SERVER.enemy.hitAnimMs,
    'anim override still uses the standard window');
});

test('resolveEnemyHit with a dead or missing enemy is a full no-op', () => {
  const h = makeHarness();
  const corpse = makeEnemy(0);
  assert.deepEqual(resolveEnemyHit(h.ctx, corpse, 10, 18, 18, 'sid-1'),
    { hit: false, killed: false }, 'dead enemy never re-hit');
  assert.equal(corpse.hp, 0);
  assert.deepEqual(h.xpGrants, []);
  assert.deepEqual(h.logNames(), []);
  // Unknown killer sid: kill lands but nothing is awarded to anyone.
  const enemy = makeEnemy(2);
  const result = resolveEnemyHit(h.ctx, enemy, 2, 18, 18, 'ghost-sid');
  assert.deepEqual(result, { hit: true, killed: true });
  assert.equal(h.player.score, 0, 'unknown sid awards no score');
  assert.deepEqual(h.xpGrants, [], 'unknown sid grants no XP');
  assert.ok(h.logNames().includes('enemy_killed'), 'kill still logged');
  // Null killer (burn/environmental-style kill): same as unknown.
  const enemy2 = makeEnemy(2);
  resolveEnemyHit(h.ctx, enemy2, 2, 18, 18, null);
  assert.equal(h.player.score, 0);
  assert.deepEqual(h.xpGrants.filter((g) => g.sid === null), []);
});

// ---------------------------------------------------------------------------
// D4 — burn DoT register / start / tick
// ---------------------------------------------------------------------------

test('registerProjBurn is idempotent per projectile id (last def wins)', () => {
  const h = makeHarness();
  registerProjBurn(h.ctx, 7, BURN_DEF);
  registerProjBurn(h.ctx, 7, { ...BURN_DEF, damage: 9 });
  assert.equal(h.ctx.burnByProjId.size, 1, 'one entry per projectile id');
  assert.equal(h.ctx.burnByProjId.get(7).damage, 9, 're-register overwrites');
  registerProjBurn(h.ctx, 8, BURN_DEF);
  assert.equal(h.ctx.burnByProjId.size, 2);
});

test('startBurnFromProjectile promotes the def into activeBurns keyed by enemy', () => {
  const h = makeHarness();
  const proj = new ProjectileState(7, 'sid-1', 'fireball', 20, 20, 0, 1);
  assert.equal(startBurnFromProjectile(h.ctx, proj, makeEnemy()), false,
    'no burn registered -> no-op');
  registerProjBurn(h.ctx, proj.id, BURN_DEF);
  const enemy = makeEnemy(30);
  assert.equal(startBurnFromProjectile(h.ctx, proj, enemy), true);
  assert.equal(h.ctx.burnByProjId.has(proj.id), false, 'handoff consumes the registration');
  const burn = h.ctx.activeBurns.get(enemy);
  assert.ok(burn, 'active burn keyed by the ENEMY object');
  assert.deepEqual(
    { damage: burn.damage, remainingMs: burn.remainingMs, tickMs: burn.tickMs },
    { damage: BURN_DEF.damage, remainingMs: BURN_DEF.durationMs, tickMs: BURN_DEF.tickMs },
  );
  assert.equal(burn.lastTickMs, h.time(), 'first tick anchored to the injected clock');
  assert.equal(startBurnFromProjectile(h.ctx, proj, enemy), false,
    'already-consumed projectile cannot start a second burn');
});

test('tickBurns damages only after tickMs elapsed, then resets the anchor', () => {
  const h = makeHarness();
  const enemy = makeEnemy(30);
  h.ctx.activeBurns.set(enemy, {
    damage: BURN_DEF.damage,
    remainingMs: BURN_DEF.durationMs,
    tickMs: BURN_DEF.tickMs,
    lastTickMs: h.time(),
  });

  h.advance(BURN_DEF.tickMs - 1); // not yet due
  tickBurns(h.ctx, h.time());
  assert.equal(enemy.hp, 30, 'no damage before the tick interval elapses');

  h.advance(1); // exactly tickMs
  tickBurns(h.ctx, h.time());
  assert.equal(enemy.hp, 27, 'one tick of damage');
  const burn = h.ctx.activeBurns.get(enemy);
  assert.equal(burn.lastTickMs, h.time(), 'anchor reset to now');
  assert.equal(burn.remainingMs, BURN_DEF.durationMs - BURN_DEF.tickMs, 'remaining decays by elapsed');

  // Large frame gap decays by the WHOLE gap, not one tick.
  h.advance(250);
  tickBurns(h.ctx, h.time());
  assert.equal(enemy.hp, 24, 'single application even after a long frame');
  assert.equal(h.ctx.activeBurns.get(enemy).remainingMs, BURN_DEF.durationMs - 350,
    'remainingMs decayed by the whole elapsed gap (100 + 250)');
});

test('tickBurns drops exhausted burns and dead enemies', () => {
  const h = makeHarness();
  const dying = makeEnemy(2);
  const dead = makeEnemy(0);
  const fresh = makeEnemy(30);
  h.ctx.activeBurns.set(dying, { damage: 3, remainingMs: 100, tickMs: 10, lastTickMs: h.time() });
  h.ctx.activeBurns.set(dead, { damage: 3, remainingMs: 100, tickMs: 10, lastTickMs: h.time() });
  h.ctx.activeBurns.set(fresh, { damage: 3, remainingMs: 10_000, tickMs: 10, lastTickMs: h.time() });

  tickBurns(h.ctx, h.time()); // dead-enemy GC happens before any ticking
  assert.equal(h.ctx.activeBurns.has(dead), false, 'dead enemy dropped immediately');
  assert.equal(h.ctx.activeBurns.has(dying), true, 'living enemy still burning');

  h.advance(10);
  tickBurns(h.ctx, h.time());
  assert.equal(dying.hp, 0, 'burn clamps at 0 hp — it does not resurrect or go negative');
  assert.equal(h.ctx.activeBurns.has(dying), true, 'still has remaining time');

  h.advance(90); // exhaust the remaining 100ms window
  tickBurns(h.ctx, h.time());
  assert.equal(h.ctx.activeBurns.has(dying), false, 'expired burn dropped');
  assert.equal(h.ctx.activeBurns.has(fresh), true, 'unrelated burn untouched');
});

test('re-hitting an enemy refreshes its burn (stacking = replace, single entry)', () => {
  const h = makeHarness();
  const enemy = makeEnemy(30);
  h.ctx.activeBurns.set(enemy, { damage: 3, remainingMs: 50, tickMs: 10, lastTickMs: h.time() });
  // Second fireball hits: startBurnFromProjectile overwrites the entry, exactly
  // like both rooms did with activeBurns.set(enemy, {...}).
  const proj = new ProjectileState(9, 'sid-1', 'fireball', 20, 20, 0, 1);
  registerProjBurn(h.ctx, proj.id, BURN_DEF);
  assert.equal(startBurnFromProjectile(h.ctx, proj, enemy), true);
  assert.equal(h.ctx.activeBurns.size, 1, 'no duplicate burn entries per enemy');
  assert.equal(h.ctx.activeBurns.get(enemy).remainingMs, BURN_DEF.durationMs,
    'fresh duration replaces the old countdown');
});

// ---------------------------------------------------------------------------
// D3 — applyShopChoice
// ---------------------------------------------------------------------------

/** Move the harness into intermission so the shop gate opens. */
function inIntermission(h) {
  h.state.matchState = 'intermission';
}

test('applyShopChoice heal: floor-to-half-max + 20, clamped to maxHp', () => {
  const h = makeHarness({ character: 0 }); // knight
  inIntermission(h);
  const maxHp = effectiveMaxHp(0, h.player.upgrades);
  h.player.hp = Math.floor(maxHp * 0.2); // badly hurt

  const result = applyShopChoice(h.ctx, 'sid-1', 'heal');
  assert.deepEqual(result, { ok: true, choice: 'heal' });
  assert.equal(h.player.hp, Math.min(maxHp, Math.max(Math.floor(maxHp * 0.2), Math.floor(maxHp * 0.5) + 20)),
    'heal formula matches both rooms byte-for-byte');
  assert.deepEqual(h.msgTypes(), ['shopResult']);
  assert.deepEqual(h.messages[0], { sid: 'sid-1', type: 'shopResult', data: { picked: 'heal' } });
  assert.ok(h.logNames().includes('shop_pick'));
  assert.equal(h.events.find((e) => e.event === 'shop_pick').fields.wave, h.state.wave);
  assert.equal(h.ctx.shopChoices.get('sid-1'), 'heal', 'pick recorded once per intermission');
});

test('applyShopChoice heal clamps to maxHp when already above the heal line', () => {
  const h = makeHarness();
  inIntermission(h);
  const maxHp = effectiveMaxHp(0, h.player.upgrades);
  h.player.hp = maxHp; // full health
  applyShopChoice(h.ctx, 'sid-1', 'heal');
  assert.equal(h.player.hp, maxHp, 'over-heal is impossible');
});

test('applyShopChoice speed: timed buff for the next wave', () => {
  const h = makeHarness();
  inIntermission(h);
  applyShopChoice(h.ctx, 'sid-1', 'speed');
  assert.equal(h.player.effects.get('speed'), SERVER.powerUps.speed.durationMs);
  assert.equal(h.player.hp, effectiveMaxHp(0, h.player.upgrades), 'speed does not heal');
});

test('applyShopChoice vitality: +1 stack and +15 hp clamped to the NEW max', () => {
  const h = makeHarness({ character: 0 });
  inIntermission(h);
  const baseMax = effectiveMaxHp(0, h.player.upgrades);
  h.player.hp = baseMax; // at cap: the +15 must clamp to the raised cap
  applyShopChoice(h.ctx, 'sid-1', 'vitality');
  assert.equal(h.player.upgrades.get('vitality'), 1);
  const newMax = effectiveMaxHp(0, h.player.upgrades);
  assert.equal(newMax, baseMax + 30, 'shop vitality grants one +30-maxHP upgrade stack');
  assert.equal(h.player.hp, Math.min(newMax, baseMax + 15),
    'the instant heal is +15, clamped inside the raised cap');
});

test('applyShopChoice vitality at maxStacks still records the pick but grants nothing', () => {
  const h = makeHarness({ character: 0 });
  inIntermission(h);
  const def = getUpgrade('vitality');
  const stacks = def.maxStacks ?? 99;
  h.player.upgrades.set('vitality', stacks);
  const hpBefore = h.player.hp;
  const result = applyShopChoice(h.ctx, 'sid-1', 'vitality');
  assert.equal(result.ok, true, 'pick consumed (rooms marked picked BEFORE applying)');
  assert.equal(h.player.upgrades.get('vitality'), stacks, 'no stack past maxStacks');
  assert.equal(h.player.hp, hpBefore, 'no heal either');
  assert.deepEqual(h.msgTypes(), ['shopResult']);
});

test('applyShopChoice gates: not_intermission / already_picked / invalid_choice', () => {
  const h = makeHarness(); // playing, not intermission
  let result = applyShopChoice(h.ctx, 'sid-1', 'heal');
  assert.deepEqual(result, { ok: false, reason: 'not_intermission' });
  assert.ok(h.warnings.some((w) => w.fields.reason === 'not_intermission'), 'warned');
  assert.equal(h.player.hp, effectiveMaxHp(0, h.player.upgrades), 'no effect outside intermission');
  assert.equal(h.ctx.shopChoices.size, 0);

  inIntermission(h);
  applyShopChoice(h.ctx, 'sid-1', 'heal'); // first pick ok
  result = applyShopChoice(h.ctx, 'sid-1', 'speed'); // second pick same intermission
  assert.deepEqual(result, { ok: false, reason: 'already_picked' });
  assert.ok(h.warnings.some((w) => w.fields.reason === 'already_picked'));
  assert.equal(h.player.effects.size, 0, 'second choice had no effect');
  assert.deepEqual(h.msgTypes(), ['shopResult'], 'only ONE shopResult emitted');

  h.ctx.shopChoices.clear();
  result = applyShopChoice(h.ctx, 'sid-1', 'not_a_real_pick');
  assert.deepEqual(result, { ok: false, reason: 'invalid_choice' });
  assert.ok(h.warnings.some((w) => w.fields.reason === 'invalid_choice'));
  assert.equal(h.ctx.shopChoices.size, 0, 'invalid pick records nothing');

  result = applyShopChoice(h.ctx, 'ghost', 'heal');
  assert.equal(result.ok, false, 'unknown sid rejected silently (GR behavior)');
  assert.equal(result.reason, undefined, 'missing player warns NOTHING');
  assert.deepEqual(h.msgTypes(), ['shopResult']);
});

// ---------------------------------------------------------------------------
// Source contract — src/shared/sim/*.js imports no colyseus / StateSchema
// ---------------------------------------------------------------------------

test('source contract: src/shared/sim/*.js imports no colyseus or StateSchema', () => {
  const dir = fileURLToPath(new URL('../src/shared/sim/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('combatBook.js'), 'combatBook.js exists under src/shared/sim/');
  assert.ok(files.includes('shopEffects.js'), 'shopEffects.js exists under src/shared/sim/');
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]colyseus['"]/, `${f}: no colyseus import`);
    assert.doesNotMatch(src, /StateSchema/, `${f}: no StateSchema import`);
  }
});

// ---------------------------------------------------------------------------
// Enemy archetypes (PRD-enemy-archetypes.md): knockback routes through
// knockbackAgainst at EVERY strike site (resolveEnemyHit + both bash cones),
// so Tank's 0.25x multiplier lands everywhere by construction. Elite Bulwark
// immunity keeps winning when composed with an archetype.
// ---------------------------------------------------------------------------

test('knockbackAgainst: Tank shrugs off most of the shove', () => {
  const tank = { elite: '', archetype: 'Tank' };
  assert.equal(knockbackAgainst(tank, SERVER.enemy.hitKnockback),
    SERVER.enemy.hitKnockback * 0.25, 'tank takes 25% knockback');
});

test('knockbackAgainst: Rusher and plain chasers take full knockback', () => {
  assert.equal(knockbackAgainst({ elite: '', archetype: 'Rusher' }, 0.5), 0.5);
  assert.equal(knockbackAgainst({ elite: '', archetype: '' }, 0.5), 0.5);
  assert.equal(knockbackAgainst({}, 0.5), 0.5);
});

test('knockbackAgainst: elite Bulwark immunity wins over any archetype', () => {
  const bulwarkTank = { elite: 'Bulwark', archetype: 'Tank' };
  assert.equal(knockbackAgainst(bulwarkTank, 0.5), 0,
    'immune elite is never shoved, archetype or not');
});

test('knockbackAgainst: non-positive base passes through untouched', () => {
  assert.equal(knockbackAgainst({ elite: '', archetype: 'Tank' }, 0), 0);
});
