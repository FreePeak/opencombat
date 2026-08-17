# Root Causes: character movement/attack not smooth and not correct

TDD evidence for `test/movementAttack.test.mjs` (red first, then fixed by
`src/anim/AnimUtils.js` plus rewiring in Player/RemotePlayer/Enemy/GameScene).

## RC1 — knight_mixamo.glb bakes ROOT MOTION into the Hips bone

- **Symptom**: the knight slides/swims in directions nobody steered.
- **Cause**: the three Mixamo clips carry large `Hips.position` tracks
  (Attack sweeps ~18x17 units, Idle ~9x6, Run a ~280-unit vertical swing).
  The server is authoritative for x/z, so the animated hips drag the mesh
  away from its lerped position every frame. The legacy characters
  (archer/mage/spike) animate no meaningful bone translation and are fine.
- **Fix**: `stripRootMotion()` removes the offending position tracks at
  model-load time in `GameScene.loadModels()`; `findRootMotionClip()` is the
  detector (and the test's regression tripwire).

## RC2 — the attack clip is 1.433s but shown for 350ms

- **Symptom**: attacks look like a stuttering wind-up, not a swing.
- **Cause**: the server (and client HUD/FSM) show `anim='attack'` for
  `attackAnimMs = 350` while the clip plays at 1x, so the player sees ~24%
  of the swing before it hard-cuts back to idle.
- **Fix**: `attackTimeScale(clip, ms)` time-scales the attack action so the
  full arc fits exactly inside the window (`Player.playAnim`,
  `RemotePlayer.playAnim`).

## RC3 — the one-frame attack edge can be swallowed by the 30Hz send throttle

- **Symptom**: pressing J sometimes does nothing.
- **Cause**: `Player.update` sent input only on throttle slots with a
  last-sent diff, but `attack` is true for a single frame. If that frame is
  not a send slot, the next diff sees `attack:false` and the press is
  silently dropped.
- **Fix**: `shouldSendInput()` treats any attack edge as a change, and
  `Player` latches the edge (`pendingAttack`) until it is actually sent.

## RC4 — smoothing used fixed per-frame lerp factors (frame-rate dependent)

- **Symptom**: remote players/enemies and the camera feel different
  (jerky or floaty) depending on the machine's refresh rate.
- **Cause**: `RemotePlayer` lerped `* 0.25`, `Enemy` `* 0.2`, the camera
  `lerp(desired, 0.08)` — per-frame factors only correct at 60fps
  (30fps converges 2x slower, 120/144fps 2x faster).
- **Fix**: `frameDamp(p, dt)` (rate-corrected legacy factors) and
  `dampFactor(k, dt)` (pure exponential) make convergence identical at any

## RC5 — A/D steered the camera "round and round" (character-relative input loop)

- **Symptom**: tapping A or D makes the character — and the camera — spin in
  circles instead of strafing.
- **Cause**: `Player.update` mapped A/D onto the character's OWN right vector
  (built from `root.rotation.y`), and the server re-points the character at its
  velocity (`rotY = atan2(dirX, dirZ)`). Pressing D therefore moved you right
  *and* turned you to face right; next frame "right" was rotated 90°, so you
  traced a circle. The camera rig sat behind the character keyed off
  `root.rotation.y`, so it orbited too. A turn→move→turn feedback loop.
- **Fix**: movement + camera use one FIXED azimuth (`CONFIG.player.camera.yaw`):
  `cameraMoveDir()` maps WASD onto the camera basis (never the character yaw) and
  `cameraOffset()` places the rig behind the target without reading its rotation.
  Holding A/D strafes a constant world direction (a straight line) and the camera
  can no longer orbit. Proven live: path curvature 0.0000, camera azimuth drift
  0.0012 rad over a 1s strafe.

## RC6 — attacking slid the character ("move + attack at the same time")

- **Symptom**: swinging while holding a move key skates the character across the
  ground; attacking and moving together looks broken.
- **Cause**: `GameRoom.movePlayers` integrated `dirX*speed*dt` every tick even
  while the player was mid-swing (`now < animUntil`). The attack animation is a
  planted-feet swing with no locomotion, so the body kept translating while the
  feet were planted — a slide.
- **Fix**: `stepPlayer()` ROOTS the player while `attacking` (position + facing
  frozen); `movePlayers` passes `attacking = now < animUntil`. A swing/cast now
  briefly plants your feet (standard melee feel), so move+attack can no longer
  slide. Proven live: server position moved 0.0000 units while attacking with W
  held (was ~1.8).

## SKILL — every character shares the J melee but casts its own K skill

- **Requirement**: all characters have the same normal attack (J); each casts a
  DIFFERENT skill (K).
- **Design**: `src/shared/skills.js` holds `SKILLS` (one per class: Whirlwind /
  Piercing Shot / Arcane Nova / Frenzy Slam) + pure `resolveSkillHits()`
  (`aoe` = everything in a radius; `cone` = within range + facing arc). The
  server enforces cooldown/damage authoritatively (`castSkill`), roots the caster
  for the cast (RC6), and shows `anim='skill'`; the client plays the class swing
  time-scaled to the skill window, spawns a colored burst, and shows a skill
  cooldown bar. Pinned by `test/strafeRootSkill.test.mjs`.

  frame rate.
