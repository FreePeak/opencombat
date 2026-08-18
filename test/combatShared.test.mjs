// Phase 0 contract: the combat math in src/shared/combat.js is the ONE source
// of truth both sims (GameRoom server room + LocalRoom offline room) consume.
// These pin the pure rules — arc reach, block arc, enemy/player strikes —
// against the real SERVER tunables so a Phase 1-3 rule change lands once and
// both sims inherit it.
// Run: node --test (or node test/combatShared.test.mjs)
import assert from 'node:assert/strict';
import { SERVER } from '../src/server/config.js';
import {
  facingVector, inArc, meleeHits, blockedHit, strikeEnemy, strikePlayer
} from '../src/shared/combat.js';

const { attackRange, attackArcCos, blockArcCos, knockback } = SERVER.player;
const half = SERVER.world.size / 2;

// --- facingVector: atan2 convention (+Z is 0, +X is +90°) ----------------
{
  const f0 = facingVector(0);
  assert.ok(Math.abs(f0.fx - 0) < 1e-9 && Math.abs(f0.fz - 1) < 1e-9, 'rotY 0 faces +Z');
  const f90 = facingVector(Math.PI / 2);
  assert.ok(Math.abs(f90.fx - 1) < 1e-9 && Math.abs(f90.fz - 0) < 1e-9, 'rotY +PI/2 faces +X');
  const fNeg = facingVector(-Math.PI / 2);
  assert.ok(Math.abs(fNeg.fx + 1) < 1e-9 && Math.abs(fNeg.fz - 0) < 1e-9, 'rotY -PI/2 faces -X');
}

// --- inArc: reach + frontal cone ------------------------------------------
{
  const f = facingVector(0); // +Z
  assert.ok(inArc(f.fx, f.fz, attackRange, attackArcCos, 0, 1), 'dead ahead in range hits');
  assert.ok(inArc(f.fx, f.fz, attackRange, attackArcCos, 0, attackRange), 'hit at exact range edge');
  assert.ok(!inArc(f.fx, f.fz, attackRange, attackArcCos, 0, attackRange + 0.1), 'beyond range misses');
  assert.ok(!inArc(f.fx, f.fz, attackRange, attackArcCos, 0, -1), 'behind misses');
  assert.ok(!inArc(f.fx, f.fz, attackRange, attackArcCos, 0, 0), 'zero distance never hits (dot 0 vs arcCos>0)');
  // At the 60° cone edge (arcCos 0.5): cos(60°) = 0.5 exactly -> hit (>=).
  const edge = { x: Math.sin(Math.PI / 3), z: Math.cos(Math.PI / 3) }; // 60° off facing
  assert.ok(inArc(f.fx, f.fz, attackRange, attackArcCos, edge.x, edge.z), 'arc edge is inclusive');
}

// --- meleeHits: index list, dead-skip, arc ---------------------------------
{
  const attacker = { x: 0, z: 0, rotY: 0 };
  const targets = [
    { x: 0, z: 1, hp: 2 },            // 0: dead ahead -> hit
    { x: 2, z: 0, hp: 2 },            // 1: to the side, out of the 60° cone
    { x: 0, z: 0, hp: 0 },            // 2: dead (skipped)
    { x: 0, z: attackRange, hp: 2 }   // 3: at max reach -> hit
  ];
  assert.deepEqual(meleeHits(attacker, targets, SERVER.player), [0, 3],
    'meleeHits returns indices of living in-arc targets only');
  // Targets without hp (the PvP single-target check) are never skipped.
  assert.deepEqual(meleeHits(attacker, [{ x: 0, z: 1 }], SERVER.player), [0],
    'hp-less target still hit');
}

// --- blockedHit: guarding + source in frontal hemisphere --------------------
{
  const player = { x: 0, z: 0, rotY: 0, blocking: true };
  assert.ok(blockedHit(player, 0, 1, blockArcCos), 'frontal source blocked');
  assert.ok(!blockedHit(player, 0, -1, blockArcCos), 'rear source not blocked');
  assert.ok(!blockedHit({ ...player, blocking: false }, 0, 1, blockArcCos),
    'not guarding -> never blocked');
}

// --- strikeEnemy: hp drop + knockback + dead-stays-dead ---------------------
{
  const enemy = { x: 0, z: 0, hp: 2 };
  const r = strikeEnemy(enemy, 1, -1, 0, SERVER.enemy.hitKnockback, half);
  assert.ok(r.hit && !r.killed, 'survivor hit');
  assert.equal(enemy.hp, 1, 'hp dropped by damage');
  assert.ok(enemy.x > 0, 'knocked away from the source');
  const r2 = strikeEnemy(enemy, 1, -1, 0, SERVER.enemy.hitKnockback, half);
  assert.ok(r2.hit && r2.killed, 'killing blow reported');
  assert.equal(enemy.hp, 0, 'hp clamps at 0');
  const before = enemy.hp;
  const r3 = strikeEnemy(enemy, 1, -1, 0, SERVER.enemy.hitKnockback, half);
  assert.ok(!r3.hit && !r3.killed, 'dead enemy ignores further hits');
  assert.equal(enemy.hp, before, 'dead enemy hp untouched');
  // Knockback clamps inside the arena.
  const corner = { x: half, z: half, hp: 5 };
  strikeEnemy(corner, 1, -10, -10, 1000, half);
  assert.ok(corner.x <= half && corner.z <= half, 'knockback never leaves the arena');
}

// --- strikePlayer: hp clamp + knockback (server nudges, offline passes 0) ---
{
  const player = { x: 0, z: 0, hp: 10 };
  const died = strikePlayer(player, 10, -1, 0, knockback * 0.15, half);
  assert.ok(died, 'lethal hit reported');
  assert.equal(player.hp, 0, 'hp clamps at 0');
  assert.ok(player.x > 0, 'server nudge shoves the victim away');
  const still = { x: 0, z: 0, hp: 10 };
  strikePlayer(still, 5, -1, 0, 0, half);
  assert.equal(still.hp, 5, 'hp drops');
  assert.equal(still.x, 0, 'knockback 0 leaves position unchanged (LocalRoom)');
}

console.log('ok — combatShared.test.mjs: shared combat math (arc/block/strike) matches both sims');
process.exit(0);
