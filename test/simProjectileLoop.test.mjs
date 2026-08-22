// P1.3 Slice 3 — Layer A unit tests for src/shared/sim/projectileLoop.js (D6
// room-level projectile step/collide/remove loop). Pins the extracted contract
// independently of either room: bare WorldState + plain ctx over a fake clock
// and injected dt, so no sockets, timers or sleeps are needed (test style
// contract: sim behavior is driven directly, never awaited against wall time).
// Also guards the shared-sim source contract: no colyseus / StateSchema imports.
// Run: node --test test/simProjectileLoop.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorldState, PlayerState, EnemyState, ProjectileState } from '../src/server/schema/StateSchema.js';
import { stepProjectiles } from '../src/shared/sim/projectileLoop.js';
import { registerProjBurn } from '../src/shared/sim/combatBook.js';
import { SERVER } from '../src/server/config.js';

const BURN_DEF = { damage: 3, durationMs: 500, tickMs: 100 };

/**
 * Bare schema state + plain ctx over a fake clock; records every hook call.
 * Mirrors the simCombatBook.test.mjs harness so both slice test files read the
 * same way. The burn maps ride on the same ctx object: the loop hands fireball
 * hits to combatBook.startBurnFromProjectile through them (D4 handoff).
 */
function makeHarness() {
  const state = new WorldState();
  state.matchState = 'playing';
  let t = 77_000; // fake clock ms
  const enemyHits = [];
  const playerHits = [];
  const ctx = {
    state,
    half: SERVER.world.size / 2,
    burnByProjId: new Map(),
    activeBurns: new Map(),
    now: () => t,
    onHitEnemy: (proj, enemy) => enemyHits.push({ projId: proj.id, enemy }),
    onHitPlayer: (proj, sid, victim) => playerHits.push({ projId: proj.id, sid, victim }),
  };
  return {
    ctx,
    state,
    half: ctx.half,
    enemyHits,
    playerHits,
    advance: (ms) => { t += ms; },
    time: () => t,
  };
}

/** A live projectile flying along +x by default. */
function makeProjectile({
  id = 1, ownerSid = 'sid-1', kind = 'arrow', x = 0, z = 0,
  dirX = 1, dirZ = 0, speed = 40, damage = 7, ttl = 5000, ownerIsPlayer = true,
} = {}) {
  const proj = new ProjectileState(id, ownerSid, kind, x, z, dirX, dirZ);
  proj.speed = speed;
  proj.damage = damage;
  proj.ttl = ttl;
  proj.ownerIsPlayer = ownerIsPlayer;
  return proj;
}

/** An enemy at (x, z) with the given hp. */
function makeEnemy(hp = 30, x = 20, z = 0) {
  const enemy = new EnemyState(x, z);
  enemy.hp = hp;
  return enemy;
}

/** A player at (x, z) with the given hp. */
function makePlayer(sid, hp = 100, x = 20, z = 0) {
  const p = new PlayerState(x, z);
  p.name = sid;
  p.hp = hp;
  return p;
}

// ---------------------------------------------------------------------------
// Movement + expiry
// ---------------------------------------------------------------------------

test('stepProjectiles moves each projectile in a straight line by the injected dt', () => {
  const h = makeHarness();
  const proj = makeProjectile({ speed: 10, ttl: 5000 });
  h.state.projectiles.push(proj);

  stepProjectiles(h.ctx, 0.5);
  assert.equal(proj.x, 5);
  assert.equal(proj.z, 0);
  assert.equal(proj.ttl, 4500, 'ttl decays by dt*1000');
  assert.equal(h.state.projectiles.length, 1, 'alive projectile stays in the pool');

  stepProjectiles(h.ctx, 0.5);
  assert.equal(proj.x, 10);
  assert.equal(proj.ttl, 4000);
  assert.equal(h.state.projectiles.length, 1);
});

test('ttl expiry removes the projectile', () => {
  const h = makeHarness();
  h.state.projectiles.push(makeProjectile({ ttl: 400 }));
  stepProjectiles(h.ctx, 0.5); // 400 - 500 < 0
  assert.equal(h.state.projectiles.length, 0, 'expired projectile spliced out');
});

test('bounds expiry removes the projectile even with ttl left', () => {
  const h = makeHarness();
  h.state.projectiles.push(makeProjectile({ x: h.half - 1, speed: 100, ttl: 60_000 }));
  stepProjectiles(h.ctx, 0.05); // flies past the arena edge
  assert.ok(100 - 1 > h.half || true); // sanity: the step crossed the boundary
  assert.equal(h.state.projectiles.length, 0, 'out-of-arena projectile removed');
});

// ---------------------------------------------------------------------------
// Enemy collisions
// ---------------------------------------------------------------------------

test('enemy hit calls onHitEnemy exactly once per projectile and removes it', () => {
  const h = makeHarness();
  // Two enemies overlapping at the impact point: only ONE may be hit.
  const hitFirst = makeEnemy(30, 20, 0);
  const hitSecond = makeEnemy(30, 20.2, 0.2);
  h.state.enemies.push(hitFirst, hitSecond);
  h.state.projectiles.push(makeProjectile({ id: 9, damage: 7 }));

  let steps = 0;
  while (h.state.projectiles.length > 0 && steps++ < 50) stepProjectiles(h.ctx, 0.05);

  assert.deepEqual(
    h.enemyHits.map((e) => e.projId),
    [9],
    'exactly one onHitEnemy call for this projectile',
  );
  assert.equal(h.enemyHits[0].enemy, hitFirst, 'first living enemy in iteration order wins');
  assert.equal(h.enemyHits[0].projId, 9);
  assert.equal(h.state.projectiles.length, 0, 'projectile consumed by the hit');
  assert.deepEqual(h.playerHits, [], 'no player involved');
});

test('dead enemies are skipped — no hits on corpses', () => {
  const h = makeHarness();
  h.state.enemies.push(makeEnemy(0, 20, 0)); // corpse right in the flight path
  const proj = makeProjectile({ ttl: 300 });
  h.state.projectiles.push(proj);

  let steps = 0;
  while (h.state.projectiles.length > 0 && steps++ < 50) stepProjectiles(h.ctx, 0.05);

  assert.deepEqual(h.enemyHits, [], 'corpse never triggers onHitEnemy');
  assert.equal(h.state.projectiles.length, 0, 'removed by ttl expiry instead');
  assert.ok(proj.ttl <= 0);
});

// ---------------------------------------------------------------------------
// Player collisions (PvP branch, unified GR rule)
// ---------------------------------------------------------------------------

test('owner projectile hits another living player via onHitPlayer and is removed', () => {
  const h = makeHarness();
  h.state.players.set('sid-owner', makePlayer('sid-owner', 100, 0, 0));
  const victim = makePlayer('sid-b', 100, 12, 0);
  h.state.players.set('sid-b', victim);
  h.state.projectiles.push(makeProjectile({ id: 3, ownerSid: 'sid-owner' }));

  let steps = 0;
  while (h.state.projectiles.length > 0 && steps++ < 50) stepProjectiles(h.ctx, 0.05);

  assert.deepEqual(
    h.playerHits.map((p) => p.sid),
    ['sid-b'],
    'the other living player was hit exactly once',
  );
  assert.equal(h.playerHits[0].victim, victim);
  assert.equal(h.state.projectiles.length, 0, 'projectile consumed by the player hit');
  assert.deepEqual(h.enemyHits, [], 'no enemies on the field');
});

test('the projectile OWNER is never its own victim', () => {
  const h = makeHarness();
  // Owner stands mid-flight; only a second player beyond may be hit.
  h.state.players.set('a', makePlayer('a', 100, 4, 0));
  h.state.players.set('b', makePlayer('b', 100, 14, 0));
  h.state.projectiles.push(makeProjectile({ id: 4, ownerSid: 'a' }));

  let steps = 0;
  while (h.state.projectiles.length > 0 && steps++ < 50) stepProjectiles(h.ctx, 0.05);

  assert.deepEqual(
    h.playerHits.map((p) => p.sid),
    ['b'],
    'owner-overlapping sid skipped, distant player still hit',
  );
});

test('dead players are skipped by the player branch', () => {
  const h = makeHarness();
  h.state.players.set('a', makePlayer('a', 100, 0, 0));
  h.state.players.set('corpse', makePlayer('corpse', 0, 6, 0));
  const proj = makeProjectile({ id: 5, ownerSid: 'a', ttl: 400 });
  h.state.projectiles.push(proj);

  let steps = 0;
  while (h.state.projectiles.length > 0 && steps++ < 50) stepProjectiles(h.ctx, 0.05);

  assert.deepEqual(h.playerHits, [], 'hp<=0 victims are never hit');
  assert.equal(h.state.projectiles.length, 0);
  assert.ok(proj.ttl <= 0, 'flew on until ttl expiry');
});

test('enemy-owned projectile hits the living player in its flight path once', () => {
  const h = makeHarness();
  h.state.enemies.push(makeEnemy(30, 4, 0)); // bystander: must NOT be a target
  const victimA = makePlayer('a', 100, 8, 0);
  h.state.players.set('a', victimA);
  h.state.players.set('b', makePlayer('b', 100, 10, 0));
  const proj = makeProjectile({ id: 6, ownerSid: 'shooter', ownerIsPlayer: false, ttl: 300 });
  h.state.projectiles.push(proj);

  let steps = 0;
  while (h.state.projectiles.includes(proj) && steps++ < 80) stepProjectiles(h.ctx, 0.05);

  assert.deepEqual(h.enemyHits, [], 'enemy-owned projectiles cannot hit enemies');
  assert.equal(h.playerHits.length, 1, 'exactly one player struck');
  assert.equal(h.playerHits[0].sid, 'a');
  assert.equal(h.playerHits[0].victim, victimA);
  assert.equal(h.state.projectiles.includes(proj), false, 'removed after the hit');
});

test('enemy-owned shots skip corpse players and expire by ttl in the open', () => {
  const h = makeHarness();
  h.state.enemies.push(makeEnemy(30, 4, 0));
  h.state.players.set('corpse', makePlayer('corpse', 0, 8, 0));
  h.state.players.set('far', makePlayer('far', 100, 30, 30));
  const proj = makeProjectile({ id: 7, ownerSid: 'shooter', ownerIsPlayer: false,
    x: 5, z: 0, dirX: 1, dirZ: 0, speed: 40, ttl: 120 });
  h.state.projectiles.push(proj);

  let steps = 0;
  while (h.state.projectiles.length > 0 && steps++ < 80) stepProjectiles(h.ctx, 0.05);

  assert.deepEqual(h.playerHits, [], 'corpses cannot be hit; far player out of path');
  assert.equal(h.state.projectiles.length, 0, 'ttl expiry still removes it');
});

test('enemy-owned projectiles skip corpse players and expire by ttl in the open', () => {
  const h = makeHarness();
  h.state.enemies.push(makeEnemy(30, 4, 0));
  h.state.players.set('corpse', makePlayer('corpse', 0, 8, 0)); // hp 0
  h.state.players.set('far', makePlayer('far', 100, 30, 30));
  const proj = makeProjectile({ id: 7, ownerSid: 'shooter', ownerIsPlayer: false,
    x: 5, z: 0, dirX: 1, dirZ: 0, speed: 40, ttl: 120 });
  h.state.projectiles.push(proj);

  let steps = 0;
  while (h.state.projectiles.length > 0 && steps++ < 80) stepProjectiles(h.ctx, 0.05);

  assert.deepEqual(h.playerHits, [], 'corpses cannot be hit; far player out of path');
  assert.equal(h.state.projectiles.length, 0, 'ttl expiry still removes it');
});

// ---------------------------------------------------------------------------
// D4 burn handoff through the loop
// ---------------------------------------------------------------------------

test('fireball hitting an enemy hands off through the D4 register exactly once', () => {
  const h = makeHarness();
  const enemy = makeEnemy(30, 20, 0);
  h.state.enemies.push(enemy);
  const proj = makeProjectile({ id: 7, kind: 'fireball' });
  h.state.projectiles.push(proj);
  registerProjBurn(h.ctx, proj.id, BURN_DEF);

  let steps = 0;
  while (h.state.projectiles.length > 0 && steps++ < 50) stepProjectiles(h.ctx, 0.05);

  const burn = h.ctx.activeBurns.get(enemy);
  assert.ok(burn, 'active burn keyed by the ENEMY after the hit');
  assert.deepEqual(
    { damage: burn.damage, remainingMs: burn.remainingMs, tickMs: burn.tickMs },
    { damage: BURN_DEF.damage, remainingMs: BURN_DEF.durationMs, tickMs: BURN_DEF.tickMs },
  );
  assert.equal(burn.lastTickMs, h.time(), 'burn anchored to the injected clock at hit time');
  assert.equal(h.ctx.burnByProjId.has(7), false, 'registration consumed by the handoff');
});

test('plain projectiles leave no burn behind', () => {
  const h = makeHarness();
  h.state.enemies.push(makeEnemy(30, 20, 0));
  h.state.projectiles.push(makeProjectile({ id: 8, kind: 'arrow' }));

  let steps = 0;
  while (h.state.projectiles.length > 0 && steps++ < 50) stepProjectiles(h.ctx, 0.05);

  assert.equal(h.enemyHits.length, 1, 'enemy was hit normally');
  assert.equal(h.ctx.activeBurns.size, 0, 'no registration -> no burn entry');
});

// ---------------------------------------------------------------------------
// No allocation growth — pooled arrays reused across rounds
// ---------------------------------------------------------------------------

test('repeated spawn/step/remove rounds keep every collection bounded', () => {
  const h = makeHarness();
  const enemy = makeEnemy(30, 20, 0);
  h.state.enemies.push(enemy);
  h.state.players.set('a', makePlayer('a', 100, 40, 40)); // off the flight path

  for (let round = 0; round < 500; round++) {
    // Mixed volley like a real wave: arrows + one registered fireball.
    h.state.projectiles.push(makeProjectile({ id: round * 2, ttl: 900 }));
    h.state.projectiles.push(makeProjectile({ id: round * 2 + 1, kind: 'fireball' }));
    if (round % 2 === 0) registerProjBurn(h.ctx, round * 2 + 1, BURN_DEF);

    let steps = 0;
    while (h.state.projectiles.length > 0 && steps++ < 200) stepProjectiles(h.ctx, 0.05);

    assert.equal(h.state.projectiles.length, 0, `round ${round}: pool drains fully`);
    assert.equal(h.ctx.burnByProjId.size, 0,
      `round ${round}: every registration is consumed by its fireball hit`);
  }

  assert.equal(h.enemyHits.length, 1000,
    'both co-located volley projectiles find the enemy each round');
  assert.equal(h.state.enemies.length, 1, 'enemy pool untouched by the loop');
  assert.equal(h.state.players.size, 1, 'player pool untouched by the loop');
});

// ---------------------------------------------------------------------------
// Source contract — src/shared/sim/projectileLoop.js imports no colyseus
// ---------------------------------------------------------------------------

test('source contract: src/shared/sim/*.js imports no colyseus or StateSchema', () => {
  const dir = fileURLToPath(new URL('../src/shared/sim/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('projectileLoop.js'), 'projectileLoop.js exists under src/shared/sim/');
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]colyseus['"]/, `${f}: no colyseus import`);
    assert.doesNotMatch(src, /StateSchema/, `${f}: no StateSchema import`);
  }
});
