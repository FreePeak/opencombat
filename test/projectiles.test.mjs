// Phase 1 contract: projectile math in src/shared/projectiles.js is the ONE
// source of truth for ranged normal attacks (archer arrow, mage fireball,
// demon lightning). These pin the pure rules — movement, collision, TTL,
// block interaction — against the real SERVER tunables.
// Also verifies the INTEGRATION: a LocalRoom archer firing actually spawns a
// projectile into state.projectiles (typed ArraySchema — a plain object would
// throw EncodeSchemaError and crash the offline sim) and it flies + hits.
// Run: node --test (or node test/projectiles.test.mjs)
import assert from 'node:assert/strict';
import { SERVER } from '../src/server/config.js';
import {
  stepProjectile, projectileExpired, projectileHitsTarget,
  resolveProjectileEnemyHit, resolveProjectilePlayerHit
} from '../src/shared/projectiles.js';
import { attackFor } from '../src/shared/classes.js';
import { LocalRoom } from '../src/LocalRoom.js';

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

const half = SERVER.world.size / 2;
const p = SERVER.projectile;

// --- attackFor: per-class attack definitions --------------------------------
{
  const knight = attackFor(0);
  assert.equal(knight.kind, 'melee', 'knight keeps melee');

  const archer = attackFor(1);
  assert.equal(archer.kind, 'projectile', 'archer fires projectile');
  assert.equal(archer.projKind, 'arrow', 'archer projectile is arrow');

  const mage = attackFor(2);
  assert.equal(mage.kind, 'projectile', 'mage fires projectile');
  assert.equal(mage.projKind, 'fireball', 'mage projectile is fireball');

  const demon = attackFor(3);
  assert.equal(demon.kind, 'projectile', 'demon fires projectile');
  assert.equal(demon.projKind, 'lightning', 'demon projectile is lightning');

  // Out-of-range character falls back to melee
  const fallback = attackFor(99);
  assert.equal(fallback.kind, 'melee', 'unknown character falls back to melee');
}

// --- stepProjectile: linear movement ----------------------------------------
{
  const proj = { x: 0, z: 0, dirX: 1, dirZ: 0, speed: 10, ttl: 1000 };
  stepProjectile(proj, 0.1);
  assert.ok(Math.abs(proj.x - 1) < 1e-9, 'moved 1 unit in +X at speed 10, dt 0.1');
  assert.ok(Math.abs(proj.z - 0) < 1e-9, 'z unchanged');
  assert.ok(Math.abs(proj.ttl - 900) < 1e-9, 'ttl decreased by 100ms');

  // Diagonal movement
  const proj2 = { x: 0, z: 0, dirX: 0.7071, dirZ: 0.7071, speed: 10, ttl: 500 };
  stepProjectile(proj2, 0.5);
  assert.ok(proj2.x > 3 && proj2.x < 4, 'diagonal X moved correctly');
  assert.ok(proj2.z > 3 && proj2.z < 4, 'diagonal Z moved correctly');
  assert.ok(Math.abs(proj2.ttl - 0) < 1e-9, 'ttl depleted');
}

// --- projectileExpired: TTL + arena bounds -----------------------------------
{
  // TTL expired
  assert.ok(projectileExpired({ x: 0, z: 0, ttl: 0 }, half), 'ttl 0 = expired');
  assert.ok(projectileExpired({ x: 0, z: 0, ttl: -10 }, half), 'negative ttl = expired');

  // Still alive
  assert.ok(!projectileExpired({ x: 0, z: 0, ttl: 100 }, half), 'positive ttl + in bounds = alive');

  // Out of bounds (arena is ±half)
  assert.ok(projectileExpired({ x: half + 1, z: 0, ttl: 100 }, half), 'past +X edge = expired');
  assert.ok(projectileExpired({ x: -half - 1, z: 0, ttl: 100 }, half), 'past -X edge = expired');
  assert.ok(projectileExpired({ x: 0, z: half + 1, ttl: 100 }, half), 'past +Z edge = expired');
  assert.ok(projectileExpired({ x: 0, z: -half - 1, ttl: 100 }, half), 'past -Z edge = expired');

  // Exactly on the edge is still inside
  assert.ok(!projectileExpired({ x: half, z: 0, ttl: 100 }, half), 'on the edge = alive');
}

// --- projectileHitsTarget: circle collision ----------------------------------
{
  const proj = { x: 0, z: 0 };
  const target = { x: 0.5, z: 0 };
  assert.ok(projectileHitsTarget(proj, target, 0.8), 'within hitRadius = hit');
  assert.ok(!projectileHitsTarget(proj, target, 0.4), 'outside hitRadius = miss');
  assert.ok(projectileHitsTarget(proj, proj, 0.8), 'same position = hit');
  assert.ok(!projectileHitsTarget(proj, { x: 10, z: 10 }, 0.8), 'far away = miss');
}

// --- resolveProjectileEnemyHit: reuse strikeEnemy ---------------------------
{
  const enemy = { x: 0, z: 0, hp: 2 };
  const r = resolveProjectileEnemyHit(enemy, 1, -5, 0, SERVER.enemy.hitKnockback, half);
  assert.ok(r.hit && !r.killed, 'survivor hit from projectile');
  assert.equal(enemy.hp, 1, 'hp dropped');
  assert.ok(enemy.x > 0, 'knocked away from source');

  const r2 = resolveProjectileEnemyHit(enemy, 1, -5, 0, SERVER.enemy.hitKnockback, half);
  assert.ok(r2.hit && r2.killed, 'killing blow');
  assert.equal(enemy.hp, 0, 'hp at 0');
}

// --- resolveProjectilePlayerHit: block + damage ------------------------------
{
  // Unguarded player takes damage
  const p1 = { x: 0, z: 0, rotY: 0, hp: 100, blocking: false };
  const r1 = resolveProjectilePlayerHit(p1, 5, -5, 0, 0, half, SERVER.player.blockArcCos);
  assert.ok(!r1.blocked, 'not blocking = not blocked');
  assert.ok(!r1.killed, 'survived');
  assert.equal(p1.hp, 95, 'hp dropped by 5');

  // Guarding player blocks frontal hit
  const p2 = { x: 0, z: 0, rotY: 0, hp: 100, blocking: true };
  const r2 = resolveProjectilePlayerHit(p2, 5, 0, 5, 0, half, SERVER.player.blockArcCos);
  assert.ok(r2.blocked, 'guarding + frontal = blocked');
  assert.equal(p2.hp, 100, 'no hp lost');

  // Guarding player does NOT block rear hit
  const p3 = { x: 0, z: 0, rotY: 0, hp: 100, blocking: true };
  const r3 = resolveProjectilePlayerHit(p3, 5, 0, -5, 0, half, SERVER.player.blockArcCos);
  assert.ok(!r3.blocked, 'guarding + rear = not blocked');
  assert.equal(p3.hp, 95, 'hp dropped');
}

// --- INTEGRATION: LocalRoom archer fires a real projectile ------------------
// Regression guard: _spawnProjectile must push a ProjectileState instance into
// the typed ArraySchema — a plain object throws EncodeSchemaError and crashes
// the offline sim on ANY ranged attack (missed by the pure-math tests above).
{
  const room = new LocalRoom();
  await room.join('SoloArcher', 1); // archer = projectile normal attack
  room._running = false;            // stop the auto-tick; drive _step manually
  room._countdownTimer = 0;
  room.state.matchState = 'playing';

  const me = room.state.players.get(room.sessionId);
  me.x = 0; me.z = 0; me.rotY = 0; // faces +Z

  // Park every enemy except slot 0, put it in the arrow's path.
  room.state.enemies.forEach((e, i) => { if (i > 0) { e.x = 25; e.z = 25; } });
  const enemy = room.state.enemies[0];
  enemy.x = 0; enemy.z = 6; enemy.hp = SERVER.enemy.hp;

  // Fire: the attack must NOT throw, and a projectile must appear in state.
  room.send('input', { dirX: 0, dirZ: 1, attack: true, skill: false, anim: 'run', block: false });
  room._step(0.05);
  assert.equal(room.state.projectiles.length, 1,
    'archer attack spawns exactly one projectile (no EncodeSchemaError)');
  const proj = room.state.projectiles[0];
  assert.equal(proj.kind, 'arrow', 'projectile kind is arrow');
  assert.ok(Math.abs(proj.dirX - 0) < 1e-9 && Math.abs(proj.dirZ - 1) < 1e-9,
    'projectile flies in the facing direction');

  // Step it forward ~40 ticks at 1/20s: 18 units/s * 2s = 36 units, enough to
  // cover the 6-unit gap. The enemy (hp 2, arrow damage 1) must take damage.
  let hit = false;
  for (let i = 0; i < 40 && !hit; i++) {
    room._step(0.05);
    hit = room.state.projectiles.length === 0;
  }
  assert.ok(hit, 'projectile removed after reaching the enemy');
  assert.equal(enemy.hp, SERVER.enemy.hp - SERVER.projectile.arrowDamage,
    'arrow damage applied to the enemy');
  assert.equal(enemy.anim, 'hit', 'struck enemy is in hit-stun');
}

// --- INTEGRATION: knight attack spawns NO projectile -------------------------
{
  const room = new LocalRoom();
  await room.join('SoloKnight', 0); // knight = melee normal attack
  room._running = false;
  room._countdownTimer = 0;
  room.state.matchState = 'playing';

  const me = room.state.players.get(room.sessionId);
  me.x = 0; me.z = 0; me.rotY = 0;

  room.send('input', { dirX: 0, dirZ: 1, attack: true, skill: false, anim: 'run', block: false });
  room._step(0.05);
  assert.equal(room.state.projectiles.length, 0, 'knight attack spawns no projectile');
}

console.log('ok — projectiles.test.mjs: projectile math + LocalRoom integration (spawn/fly/hit) matches both sims');
process.exit(0);
