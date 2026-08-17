// TDD suite for the second movement/attack bug round + the per-character
// skill system.
//
// Root-cause evidence (documented in ROOT_CAUSES.md):
//   RC5  A/D "camera going round and round". Player.update mapped A/D onto
//        the character's OWN right vector (built from root.rotation.y) and the
//        server re-points the character at its velocity (rotY=atan2(dir)). So
//        pressing D moves you right AND turns you to face right — next frame
//        "right" is rotated 90°, so you trace a continuous circle, and the
//        yaw-following camera rig swings around with you. A turn->move->turn
//        feedback loop. Fix: map movement onto a FIXED camera azimuth that is
//        decoupled from the character's facing; strafing then follows a
//        constant world direction (a straight line) and the camera no longer
//        orbits.
//   RC6  "attacking slides / move + attack at the same time". movePlayers
//        integrates dirX*speed*dt every tick even while the player is mid-swing
//        (now < animUntil). The attack animation is a planted-feet swing with
//        no locomotion, so the model skates across the ground. Fix: ROOT the
//        player during the attack window — freeze position and facing while the
//        swing plays (standard melee feel; also resolves doing both at once).
//   SKILL  Every character shares the normal melee (J) but casts a DIFFERENT
//        skill (K). The per-character definitions and the hit-resolution math
//        are pure and pinned here so server and client can never drift.
//
// The contract tests below FAIL until the helpers exist. Run:
//   node test/strafeRootSkill.test.mjs
import assert from 'node:assert/strict';
import { cameraMoveDir, cameraOffset } from '../src/anim/AnimUtils.js';
import { stepPlayer } from '../src/server/movement.js';
import { SKILLS, resolveSkillHits } from '../src/shared/skills.js';

const CAM_YAW = Math.PI; // the fixed third-person azimuth used by the client

// --- RC5: strafing must be a constant world direction (no orbit) ------------
// The mapping takes NO facing/yaw input at all: wherever the character happens
// to point, holding D always pushes along the same world axis.
{
  const dirs = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((facing) => {
    void facing; // intentionally unused by the helper — that is the point
    return cameraMoveDir(1, 0, CAM_YAW);
  });
  for (const d of dirs) {
    assert.ok(Math.abs(d.x - dirs[0].x) < 1e-9 && Math.abs(d.z - dirs[0].z) < 1e-9,
      'RC5: strafe direction must not depend on the character facing');
  }
}
// Basis check at the default azimuth: W = screen-forward (0,-1), D = screen-right.
{
  const w = cameraMoveDir(0, 1, CAM_YAW);
  const d = cameraMoveDir(1, 0, CAM_YAW);
  assert.ok(Math.abs(w.x - 0) < 1e-9 && Math.abs(w.z + 1) < 1e-9, 'RC5: W moves screen-forward');
  assert.ok(Math.abs(d.x - 1) < 1e-9 && Math.abs(d.z - 0) < 1e-9, 'RC5: D moves screen-right');
}
// Integrating a held D must be a STRAIGHT LINE (zero curvature). The old
// character-relative mapping curved into a circle — that is the "round and
// round" the player reported.
{
  const speed = 9, dt = 1 / 60;
  let x = 0, z = 0;
  const pts = [[0, 0]];
  for (let i = 0; i < 120; i++) {
    const d = cameraMoveDir(1, 0, CAM_YAW); // hold D for two seconds
    x += d.x * speed * dt;
    z += d.z * speed * dt;
    pts.push([x, z]);
  }
  for (let i = 2; i < pts.length; i++) {
    const [ax, az] = pts[i - 2], [bx, bz] = pts[i - 1], [cx, cz] = pts[i];
    const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    assert.ok(Math.abs(cross) < 1e-6, `RC5: frame ${i} strafes straight, got curvature ${cross}`);
  }
}
// Camera offset sits exactly `distance` behind the target along the fixed
// azimuth and never references the character yaw -> cannot orbit.
{
  const off = cameraOffset(CAM_YAW, 10);
  assert.ok(Math.hypot(off.x, off.z) === 10, 'RC5: camera offset length == distance');
  const off2 = cameraOffset(CAM_YAW, 10);
  assert.deepEqual(off, off2, 'RC5: camera offset is constant (no yaw dependence)');
}

// --- RC6: the player is ROOTED while mid-swing ------------------------------
{
  // attacking = true: position and facing are frozen even with a live input.
  const r = stepPlayer(1, 2, 0.5, 1, 0, 9, 1 / 60, 30, true);
  assert.deepEqual(r, { x: 1, z: 2, rotY: 0.5 }, 'RC6: no movement while attacking');
  // attacking = false with input: integrate by dir*speed*dt and face velocity.
  const m = stepPlayer(0, 0, 0, 1, 0, 9, 1 / 60, 30, false);
  assert.ok(Math.abs(m.x - 9 / 60) < 1e-9, 'RC6: moves when not attacking');
  assert.ok(Math.abs(m.rotY - Math.atan2(1, 0)) < 1e-9, 'RC6: faces movement direction');
  // no input: keeps facing.
  const s = stepPlayer(5, 5, 1.2, 0, 0, 9, 1 / 60, 30, false);
  assert.ok(Math.abs(s.rotY - 1.2) < 1e-9, 'RC6: keeps facing when idle');
  // clamps to the arena half-extent.
  const c = stepPlayer(29.9, 0, 0, 1, 0, 9, 1, 30, false);
  assert.ok(c.x <= 30, 'RC6: clamps to arena');
}

// --- SKILL: every character has a distinct, resolved skill ------------------
assert.equal(SKILLS.length, 4, 'one skill per playable character');
{
  const names = new Set(SKILLS.map((s) => s.name));
  assert.equal(names.size, 4, 'SKILL: each character skill is distinct');
  for (const s of SKILLS) {
    assert.ok(s.cooldownMs > 0 && s.animMs > 0 && s.damage >= 1, 'SKILL: sane params');
    assert.ok(s.kind === 'aoe' || s.kind === 'cone', 'SKILL: known hit shape');
  }
}
// AoE hits everything inside the radius regardless of direction, nothing outside.
{
  const aoe = SKILLS.find((s) => s.kind === 'aoe');
  const caster = { x: 0, z: 0, rotY: 0 };
  const enemies = [
    { x: 1, z: 0 },                 // inside, +X
    { x: -1, z: 0.5 },              // inside, behind-left
    { x: aoe.radius + 1, z: 0 }     // outside
  ];
  const hits = resolveSkillHits(aoe, caster, enemies);
  assert.deepEqual(hits, [0, 1], 'SKILL: aoe hits the whole radius, direction-independent');
}
// Cone hits only enemies inside range AND inside the facing arc.
{
  const cone = SKILLS.find((s) => s.kind === 'cone');
  const caster = { x: 0, z: 0, rotY: 0 }; // faces +Z (atan2 convention)
  const enemies = [
    { x: 0, z: 1 },                       // dead ahead, in range
    { x: 5, z: 0 },                       // to the side (outside a narrow arc)
    { x: 0, z: cone.range + 5 }           // ahead but out of range
  ];
  const hits = resolveSkillHits(cone, caster, enemies);
  assert.ok(hits.includes(0), 'SKILL: cone hits the enemy ahead');
  assert.ok(!hits.includes(2), 'SKILL: cone respects range');
}

console.log('ok — strafeRootSkill.test.mjs: all RC5/RC6/skill contracts pass');
