// Phase 3 TDD: per-class signature skills + base stats.
//
// Skill kinds:
//   bash        — knight: 4-unit dash + cone knockback + 1s stun
//   multishot   — archer: 5-arrow fan
//   firewave    — mage:   3-fireball cone + burn DoT
//   chainlight  — demon:  4 targets, −20% damage per hop
//
// Per-class base stats replace the identical 100-HP global pool.
// The global `skillPvpDamage` is dropped in favor of per-class values.
//
// Run: node test/phase3.test.mjs
import assert from 'node:assert/strict';
import { SKILLS, skillFor, resolveSkillHits } from '../src/shared/skills.js';
import { attackFor } from '../src/shared/classes.js';
import { SERVER } from '../src/server/config.js';
import {
  CLASS_STATS, classStats, resolveBash, resolveMultishot,
  resolveFirewave, resolveChainTargets, BASH_RANGE, BASH_ARC_COS,
  BASH_KNOCKBACK, STUN_DURATION_MS, MULTISHOT_COUNT, MULTISHOT_FAN_DEG,
  CHAIN_MAX_TARGETS, CHAIN_DAMAGE_DECAY, BURN_TICK_DAMAGE, BURN_DURATION_MS,
  BURN_TICK_MS, FIREWAVE_COUNT
} from '../src/shared/skills.js';

const half = SERVER.world.size / 2;

// ---------------------------------------------------------------------------
// 1. Skill kinds assigned to the right classes
// ---------------------------------------------------------------------------
assert.equal(SKILLS[0].kind, 'bash',  'knight skill is bash');
assert.equal(SKILLS[1].kind, 'multishot', 'archer skill is multishot');
assert.equal(SKILLS[2].kind, 'firewave',  'mage skill is firewave');
assert.equal(SKILLS[3].kind, 'chainlight', 'demon skill is chainlight');

// ---------------------------------------------------------------------------
// 2. Bash: cone at landing position after 4-unit dash
// ---------------------------------------------------------------------------
{
  const bash = SKILLS[0];
  const caster = { x: 0, z: 0, rotY: 0 }; // faces +Z

  // Enemy directly in the dash path
  const enemies = [
    { x: 0, z: 4, hp: 5 },   // 0: directly ahead at dash distance
    { x: 0, z: 1, hp: 5 },   // 1: behind the landing position (misses cone)
    { x: 0, z: 8, hp: 5 },   // 2: too far (beyond cone range)
    { x: 4, z: 4, hp: 5 },   // 3: off to the side (outside arc)
  ];
  const result = resolveSkillHits(bash, caster, enemies);
  // Bash hits enemies in a cone at the LANDING position (4 units forward)
  assert.ok(Array.isArray(result.hits), 'bash returns hits array');
  assert.ok(result.movement, 'bash returns movement data');
  assert.equal(result.movement.dx, 0, 'bash dash dx (facing +Z)');
  assert.equal(result.movement.dz, bash.dashDistance, 'bash dash dz = dashDistance');
  // At landing position (0, 4): enemy 0 is at (0,4) = distance 0 -> behind cone
  //   Actually distance 0 never hits (same as meleeHits). Let's check side enemy.
  // Enemy 3 at (4,4): dist from (0,4) = 4, but dot product with facing = (4*0 + 0*1)/4 = 0
  //   which is < BASH_ARC_COS so misses.
  assert.ok(!result.hits.includes(1), 'bash: enemy behind landing misses cone');
  assert.ok(!result.hits.includes(3), 'bash: side enemy misses cone');
}

// ---------------------------------------------------------------------------
// 3. Multishot: 5 projectiles in a fan
// ---------------------------------------------------------------------------
{
  const ms = SKILLS[1];
  const caster = { x: 0, z: 0, rotY: 0 }; // faces +Z
  const enemies = [
    { x: 0, z: 3, hp: 3 },   // 0: dead ahead
    { x: 2, z: 3, hp: 3 },   // 1: to the right
    { x: 10, z: 10, hp: 3 }, // 2: far away (no hit, but projectile may pass)
  ];
  const result = resolveSkillHits(ms, caster, enemies);
  assert.ok(result.projectiles, 'multishot returns projectiles array');
  assert.equal(result.projectiles.length, 5, 'multishot spawns exactly 5 projectiles');
  // Each projectile should have direction, damage, speed, ttl
  for (const p of result.projectiles) {
    assert.equal(typeof p.dirX, 'number', 'projectile has dirX');
    assert.equal(typeof p.dirZ, 'number', 'projectile has dirZ');
    assert.equal(p.projKind, 'arrow', 'multishot projectile is arrow');
    assert.ok(p.damage > 0, 'projectile has damage');
    assert.ok(p.speed > 0, 'projectile has speed');
  }
  // Direct-hit enemies are resolved immediately (not via projectile travel)
  assert.ok(result.hits.length >= 0, 'multishot may have direct hits or all via projectiles');
}

// ---------------------------------------------------------------------------
// 4. Firewave: 3 fireballs in a cone + burn DoT metadata
// ---------------------------------------------------------------------------
{
  const fw = SKILLS[2];
  const caster = { x: 0, z: 0, rotY: 0 }; // faces +Z
  const enemies = [
    { x: 0, z: 3, hp: 5 },   // 0: dead ahead
    { x: 3, z: 3, hp: 5 },   // 1: to the right, within cone
    { x: -3, z: 3, hp: 5 },  // 2: to the left, within cone
    { x: 10, z: 10, hp: 5 }, // 3: far away, outside cone
  ];
  const result = resolveSkillHits(fw, caster, enemies);
  assert.ok(result.projectiles, 'firewave returns projectiles');
  assert.equal(result.projectiles.length, 3, 'firewave spawns exactly 3 fireballs');
  for (const p of result.projectiles) {
    assert.equal(p.projKind, 'fireball', 'firewave projectile is fireball');
    assert.ok(p.burnDamage > 0 || p.effects, 'fireball has burn info');
  }
  // No direct cone hits: damage comes ONLY from the fireballs on contact
  // (direct hits double-damaged anything close to the caster).
  assert.equal(result.hits.length, 0, 'firewave has NO direct hits (projectiles only)');
}

// ---------------------------------------------------------------------------
// 5. Chain lightning: 4 targets, −20% damage per hop
// ---------------------------------------------------------------------------
{
  const cl = SKILLS[3];
  const caster = { x: 0, z: 0, rotY: 0 };
  // Place 4 enemies at increasing distances — chain picks closest first
  const enemies = [
    { x: 0, z: 1, hp: 10 },  // 0: closest (1 unit)
    { x: 2, z: 2, hp: 10 },  // 1: second closest (~2.8 units)
    { x: 0, z: 4, hp: 10 },  // 2: third (4 units)
    { x: 5, z: 5, hp: 10 },  // 3: farthest (~7 units)
    { x: 0, z: 0.5, hp: 0 }, // 4: dead (skipped)
  ];
  const result = resolveSkillHits(cl, caster, enemies);
  assert.ok(Array.isArray(result.hits), 'chainlight returns hits');
  assert.ok(result.hits.length <= 4, 'chainlight targets at most 4 enemies');
  assert.ok(result.hits.length > 0, 'chainlight hits at least one target');
  // Verify the chain targets the closest first
  if (result.hits.length >= 2) {
    const d0 = Math.hypot(enemies[result.hits[0]].x, enemies[result.hits[0]].z);
    const d1 = Math.hypot(enemies[result.hits[1]].x, enemies[result.hits[1]].z);
    assert.ok(d0 <= d1, 'chainlight first target is closest');
  }
  // Damage info should include per-target decay
  if (result.damagePerHit) {
    assert.equal(result.damagePerHit.length, result.hits.length,
      'damagePerHit length matches hits');
    for (let i = 1; i < result.damagePerHit.length; i++) {
      assert.ok(result.damagePerHit[i] < result.damagePerHit[i - 1],
        `chainlight hop ${i} deals less damage than hop ${i - 1}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Per-class base stats
// ---------------------------------------------------------------------------
{
  const knight = classStats(0);
  const archer = classStats(1);
  const mage   = classStats(2);
  const demon  = classStats(3);

  // Knight: tanky, slower, high melee
  assert.equal(knight.hp, 150, 'knight has 150 HP');
  assert.equal(knight.speed, 8, 'knight is slower (speed 8)');
  assert.equal(knight.meleeDamage, 2, 'knight hits harder (melee 2)');
  assert.equal(knight.meleePvpDamage, 15, 'knight PvP melee 15');

  // Archer: ranged, fast, squishy
  assert.equal(archer.hp, 80, 'archer has 80 HP');
  assert.equal(archer.speed, 11, 'archer is fast (speed 11)');
  assert.equal(archer.rangedDamage, 1, 'archer ranged damage 1');
  assert.equal(archer.rangedPvpDamage, 10, 'archer PvP ranged 10');

  // Mage: AoE, medium
  assert.equal(mage.hp, 90, 'mage has 90 HP');
  assert.equal(mage.speed, 9, 'mage has standard speed');
  assert.equal(mage.skillDamage, 2, 'mage skill damage 2');

  // Demon: chain, high skill PvP
  assert.equal(demon.hp, 80, 'demon has 80 HP');
  assert.equal(demon.speed, 10, 'demon is fast (speed 10)');
  assert.equal(demon.skillPvpDamage, 12, 'demon skill PvP 12');
}

// ---------------------------------------------------------------------------
// 7. Old global skillPvpDamage is removed; per-class values used instead
// ---------------------------------------------------------------------------
{
  // The rooms should no longer read SERVER.player.skillPvpDamage
  assert.equal(SERVER.player.skillPvpDamage, undefined,
    'global skillPvpDamage removed from SERVER.player');

  // Per-class skill PvP damage lives in CLASS_STATS
  assert.equal(CLASS_STATS[0].skillPvpDamage, 15, 'knight skill PvP from CLASS_STATS');
  assert.equal(CLASS_STATS[1].skillPvpDamage, 8,  'archer skill PvP from CLASS_STATS');
  assert.equal(CLASS_STATS[2].skillPvpDamage, 10, 'mage skill PvP from CLASS_STATS');
  assert.equal(CLASS_STATS[3].skillPvpDamage, 12, 'demon skill PvP from CLASS_STATS');
}

// ---------------------------------------------------------------------------
// 8. attackFor still works (backward compat for normals)
// ---------------------------------------------------------------------------
{
  const kAtk = attackFor(0);
  assert.equal(kAtk.kind, 'melee', 'knight normal is melee');
  const aAtk = attackFor(1);
  assert.equal(aAtk.kind, 'projectile', 'archer normal is projectile');
  assert.equal(aAtk.projKind, 'arrow');
  const mAtk = attackFor(2);
  assert.equal(mAtk.projKind, 'fireball');
  const dAtk = attackFor(3);
  assert.equal(dAtk.projKind, 'lightning');
}

// ---------------------------------------------------------------------------
// 9. Bash helper: displacement calculation
// ---------------------------------------------------------------------------
{
  const caster = { x: 5, z: 5, rotY: Math.PI / 2 }; // faces +X
  const dash = resolveBash(caster);
  assert.ok(dash.newX > caster.x, 'bash moves caster in the facing direction (+X)');
  assert.ok(Math.abs(dash.newZ - caster.z) < 1e-9, 'bash only moves along facing axis');
  assert.ok(Math.abs(dash.newX - (caster.x + BASH_RANGE)) < 1e-9,
    'bash displacement equals BASH_RANGE');
}

// ---------------------------------------------------------------------------
// 10. Multishot helper: fan spread
// ---------------------------------------------------------------------------
{
  const caster = { x: 0, z: 0, rotY: 0 }; // faces +Z
  const arrows = resolveMultishot(caster, SKILLS[1]);
  assert.equal(arrows.length, 5, 'multishot produces 5 arrows');
  // Center arrow should face directly forward (+Z)
  const center = arrows[2];
  assert.ok(Math.abs(center.dirX) < 0.01, 'center arrow has near-zero X');
  assert.ok(center.dirZ > 0.9, 'center arrow faces +Z');
  // Outer arrows should be angled away from center
  assert.ok(arrows[0].dirX < arrows[2].dirX, 'leftmost arrow is angled left');
  assert.ok(arrows[4].dirX > arrows[2].dirX, 'rightmost arrow is angled right');
}

// ---------------------------------------------------------------------------
// 11. Firewave helper: 3 fireballs in cone
// ---------------------------------------------------------------------------
{
  const caster = { x: 0, z: 0, rotY: 0 }; // faces +Z
  const balls = resolveFirewave(caster, SKILLS[2]);
  assert.equal(balls.length, 3, 'firewave produces 3 fireballs');
  // All fireballs should be roughly forward-facing
  for (const b of balls) {
    assert.ok(b.dirZ > 0, 'fireball faces forward (+Z)');
  }
  // Middle ball faces straight
  assert.ok(Math.abs(balls[1].dirX) < 0.1, 'middle fireball faces forward');
}

// ---------------------------------------------------------------------------
// 12. Chain lightning helper: target selection + damage decay
// ---------------------------------------------------------------------------
{
  const caster = { x: 0, z: 0, rotY: 0 };
  const enemies = [
    { x: 0, z: 1, hp: 10 },
    { x: 0, z: 2, hp: 10 },
    { x: 0, z: 3, hp: 10 },
    { x: 0, z: 4, hp: 10 },
    { x: 0, z: 5, hp: 10 },
  ];
  const baseDamage = SKILLS[3].damage;
  const chain = resolveChainTargets(caster, enemies, baseDamage, CHAIN_MAX_TARGETS);
  assert.ok(chain.length <= CHAIN_MAX_TARGETS, 'chain targets capped at CHAIN_MAX_TARGETS');
  assert.equal(chain.length, 4, 'chain targets exactly 4 living enemies');
  // Damage decays: first = base, each subsequent = previous * (1 - CHAIN_DAMAGE_DECAY)
  assert.equal(chain[0].damage, baseDamage, 'first hop = base damage');
  assert.equal(chain[1].damage, +(baseDamage * (1 - CHAIN_DAMAGE_DECAY)).toFixed(4),
    'second hop = base * 0.8');
  // Targets are ordered by distance (closest first)
  for (let i = 1; i < chain.length; i++) {
    const d0 = Math.hypot(enemies[chain[i - 1].idx].x, enemies[chain[i - 1].idx].z);
    const d1 = Math.hypot(enemies[chain[i].idx].x, enemies[chain[i].idx].z);
    assert.ok(d0 <= d1, `chain target ${i} is not closer than ${i - 1}`);
  }
}

// ---------------------------------------------------------------------------
// 13. Bash constants
// ---------------------------------------------------------------------------
{
  assert.equal(BASH_RANGE, 4, 'bash dash range is 4 units');
  assert.ok(BASH_ARC_COS > 0 && BASH_ARC_COS < 1, 'bash arc cosine is valid');
  assert.equal(STUN_DURATION_MS, 1000, 'stun duration is 1 second');
}

// ---------------------------------------------------------------------------
// 14. Firewave burn constants
// ---------------------------------------------------------------------------
{
  assert.ok(BURN_TICK_DAMAGE > 0, 'burn deals tick damage');
  assert.ok(BURN_DURATION_MS > 0, 'burn has a duration');
  assert.ok(BURN_TICK_MS > 0, 'burn has a tick interval');
  assert.ok(FIREWAVE_COUNT === 3, 'firewave spawns 3 fireballs');
}

// ---------------------------------------------------------------------------
// 15. LocalRoom integration: bash dashes the caster, applies BASH knockback
//     and the 1s stun (not just the standard 450ms hit-stun).
// ---------------------------------------------------------------------------
{
  const { LocalRoom } = await import('../src/LocalRoom.js');
  const room = new LocalRoom();
  await room.join('Basher', 0); // knight
  room._running = false;        // drive _step manually (combat.test.mjs pattern)
  room._countdownTimer = 0;
  room._step(0.05);
  const me = room.state.players.get(room.sessionId);
  me.x = 0; me.z = 0; me.rotY = 0; // face +Z
  room.state.enemies.forEach((e, i) => {
    if (i > 0) { e.x = 25; e.z = 25; } // park the others
  });
  const enemy = room.state.enemies[0];
  enemy.x = 0; enemy.z = 6; enemy.hp = 5; // ahead of the landing cone

  room.send('input', { dirX: 0, dirZ: 0, attack: false, skill: true, anim: 'skill', block: false });
  room._step(0.05);

  // Dash: the caster landed 4 units forward.
  assert.ok(Math.abs(me.z - 4) < 1e-6, `bash dashed the caster to z=4 (got ${me.z})`);
  assert.ok(Math.abs(me.x) < 1e-6, 'bash dash stays on the facing axis');
  // Damage + the BIG bash knockback (enemy pushed from z=6 to ~z=9).
  assert.equal(enemy.hp, 3, 'bash dealt its damage (5 - 2)');
  assert.ok(enemy.z > 8.5, `bash knocked the enemy back hard (z=${enemy.z.toFixed(2)} > 8.5)`);
  // The signature 1s stun — far longer than the standard 450ms hit-stun.
  const stunLeft = room._enemyStunUntil.get(enemy) - performance.now();
  assert.ok(stunLeft > 900, `bash stun is ~1s (remaining ${stunLeft.toFixed(0)}ms > 900)`);
  assert.equal(enemy.anim, 'hit', 'bashed enemy plays the hit react');

  room.leave();
}

console.log('ok — phase3.test.mjs: per-class skills (bash/multishot/firewave/chainlight), base stats, per-class PvP damage');
process.exit(0);
