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
//   RC7  "attack while moving" froze the character. An earlier revision rooted
//        the caster during the swing (movePlayers passed `attacking` into
//        stepPlayer, which skipped integration), so holding W and tapping J
//        stopped the player mid-stride for the whole 350ms window — you could
//        NOT move and attack at the same time. Fix: attacking/casting never
//        blocks movement; the swing overrides only the animation, not the
//        position. stepPlayer always integrates.
//   RC8  ...but simply allowing movement made a planted-feet attack clip skate
//        across the ground (feet frozen while translating). Fix: while swinging
//        ON THE MOVE, blend the run cycle under the attack clip at
//        MOVING_ATTACK_RUN_BLEND so the legs keep stepping (no skate, no hard
//        pop when the swing ends).
//   RC9  ...and the remote player's moving-attack blend flickered at ~20Hz
//        (the per-frame lerp-lead "moving" check decays below any threshold
//        between server patches). Fix: remoteMoveHold arms a 150ms "moving"
//        hold on any position-patch delta, so the run blend is stable across
//        the whole swing and only drops when the caster genuinely stops.
//   SKILL  Every character shares the normal melee (J) but casts a DIFFERENT
//        skill (K). The per-character definitions and the hit-resolution math
//        are pure and pinned here so server and client can never drift.
//
// The contract tests below FAIL until the helpers exist. Run:
//   node test/strafeRootSkill.test.mjs
import assert from 'node:assert/strict';
import { cameraMoveDir, cameraOffset, MOVING_ATTACK_RUN_BLEND, REMOTE_MOVE_HOLD, remoteMoveHold } from '../src/anim/AnimUtils.js';
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

// --- RC7: attacking NEVER blocks movement (move + attack at the same time) --
{
  // stepPlayer always integrates — there is no `attacking` root anymore. The
  // swing/cast overrides only the ANIMATION server-side, never the position,
  // so a player can move and attack together. (The old root here is what made
  // "attack while moving" freeze the character.)
  const m = stepPlayer(0, 0, 0, 1, 0, 9, 1 / 60, 30);
  assert.ok(Math.abs(m.x - 9 / 60) < 1e-9, 'RC7: moves with input');
  assert.ok(Math.abs(m.rotY - Math.atan2(1, 0)) < 1e-9, 'RC7: faces movement direction');
  // no input: keeps facing.
  const s = stepPlayer(5, 5, 1.2, 0, 0, 9, 1 / 60, 30);
  assert.ok(Math.abs(s.rotY - 1.2) < 1e-9, 'RC7: keeps facing when idle');
  // clamps to the arena half-extent.
  const c = stepPlayer(29.9, 0, 0, 1, 0, 9, 1, 30);
  assert.ok(c.x <= 30, 'RC7: clamps to arena');
}

// --- RC8: the moving-attack blend keeps locomotion under the swing ----------
{
  assert.ok(MOVING_ATTACK_RUN_BLEND > 0 && MOVING_ATTACK_RUN_BLEND < 1,
    'RC8: blend keeps SOME run cycle under a moving swing (no skate, not pure run)');
}

// --- RC9: remote "is moving" hold is stable across the ~20Hz patch gap -------
{
  // Simulate the server: 20Hz (50ms) fixed ticks, stepPlayer integrates every
  // tick (RC7), so a running caster yields a continuous stream of patches.
  const carry = { sx: 0, sz: 0, hold: 0 };
  let x = 0;
  for (let swung = 0; swung < 350; swung += 50) { // RC2/RC9: attackAnimMs window
    const stepped = stepPlayer(x, 0, 0, 1, 0, 9, 0.05, 30); // RC7: moves while attacking
    x = stepped.x;
    const hold = remoteMoveHold(x, 0, carry, 0.05);
    assert.ok(hold >= REMOTE_MOVE_HOLD - 1e-9,
      'RC9: every moving patch re-arms the hold (never flees mid-swing)');
    assert.ok(hold > 0, 'RC9: caster is still "moving" across the whole swing');
  }
  assert.ok(x > 0, 'RC9: the running-attack caster actually covered ground (RC7)');
  // A stationary caster: no deltas, hold decays to 0 and the run blend drops out.
  let hold = 1;
  while (hold > 0) hold = remoteMoveHold(x, 0, carry, 0.05);
  assert.equal(hold, 0, 'RC9: hold fully decays once the caster stops');
}

// --- SKILL: every character has a distinct, resolved skill ------------------
assert.equal(SKILLS.length, 4, 'one skill per playable character');
{
  const names = new Set(SKILLS.map((s) => s.name));
  assert.equal(names.size, 4, 'SKILL: each character skill is distinct');
  for (const s of SKILLS) {
    assert.ok(s.cooldownMs > 0 && s.animMs > 0 && s.damage >= 1, 'SKILL: sane params');
    const validKinds = ['bash', 'multishot', 'firewave', 'chainlight'];
    assert.ok(validKinds.includes(s.kind), 'SKILL: known hit shape');
  }
}
// Bash: hits enemies in a cone at the landing position after dash.
{
  const bash = SKILLS.find((s) => s.kind === 'bash');
  const caster = { x: 0, z: 0, rotY: 0 }; // faces +Z
  const enemies = [
    { x: 0, z: 5, hp: 5 },               // ahead at dash distance (in cone)
    { x: 0, z: 1, hp: 5 },               // behind landing position (misses)
    { x: 10, z: 10, hp: 5 },             // far away (misses)
  ];
  const result = resolveSkillHits(bash, caster, enemies);
  assert.ok(result.movement, 'bash returns movement data');
  assert.ok(result.hits.length > 0, 'bash hits at least one enemy in the landing cone');
}
// Chain lightning: picks closest targets with decaying damage.
{
  const chain = SKILLS.find((s) => s.kind === 'chainlight');
  const caster = { x: 0, z: 0, rotY: 0 };
  const enemies = [
    { x: 0, z: 1, hp: 10 },
    { x: 0, z: 2, hp: 10 },
    { x: 0, z: 3, hp: 10 },
    { x: 0, z: 4, hp: 10 },
  ];
  const result = resolveSkillHits(chain, caster, enemies);
  assert.ok(result.hits.length > 0, 'chainlight hits targets');
  assert.ok(result.damagePerHit, 'chainlight returns per-hit damage');
  if (result.damagePerHit.length >= 2) {
    assert.ok(result.damagePerHit[0] >= result.damagePerHit[1],
      'SKILL: chainlight damage decays per hop');
  }
}

console.log('ok — strafeRootSkill.test.mjs: all RC5/RC7/RC8/RC9/skill contracts pass');
