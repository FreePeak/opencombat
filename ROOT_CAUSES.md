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
- **First fix (since reverted)**: `stepPlayer()` ROOTED the player while
  `attacking` (position + facing frozen); the comment below (RC7) explains why
  that fix itself became the next bug.

## RC7 — "attack while moving" froze the character (rooting was wrong)

- **Symptom**: holding W and tapping J STOPPED the player mid-stride for the
  whole swing window — you could not move and attack at the same time.
- **Cause**: the RC6 root. Blocking integration while `now < animUntil` means
  every swing/cast shorts the player's velocity to zero for 350-800ms regardless
  of input, which reads as the character freezing every time you attack on the
  move.
- **Fix**: attacking/casting NEVER blocks movement. `stepPlayer()` always
  integrates (`movement.js`), `movePlayers` no longer passes an `attacking`
  flag, and the swing/cast only overrides the ANIMATION (`anim='attack'/'skill'`
  until `animUntil`), never the position. Pinned by
  `test/strafeRootSkill.test.mjs` (RC7 block: stepPlayer moves with input, no
  root parameter exists anymore).

## RC8 — moving attack plays the run cycle under the swing (no skate, no pop)

- **Symptom**: with RC7, a moving swing translated a planted-feet attack clip
  its whole duration — feet frozen while the body slides, and a hard pop when
  the clip snapped back to run.
- **Cause**: the attack clip has no leg locomotion; without any blend the legs
  are static under translation.
- **Fix**: `MOVING_ATTACK_RUN_BLEND` (0.42). `Player.updateClipAnims()` /
  `RemotePlayer.updateClipAnims()` drive the mixer by effective weight: while
  swinging ON THE MOVE the run cycle plays at 0.42 under the attack clip at 0.58,
  so the legs keep stepping; a stationary swing plays the clip alone. The run
  clip is never reset mid-swing, so winding down the blend is seamless.

## RC9 — remote moving-attack blend flickered between server patches

- **Symptom**: a RUNNING remote player's swing legs stuttered — the run blend
  (RC8) cut in/out ~20 times per second.
- **Cause**: `RemotePlayer.updateClipAnims()` inferred "moving" from
  `lead > 0.04`, the distance between the server position and the lerped root.
  Server patches arrive at ~20Hz (`SERVER.tickMs`), so after each patch the root
  converges and the lead decays below 0.04 before the next patch arrives — the
  flag flaps on/off at the patch rate.
- **Fix**: `remoteMoveHold()` (AnimUtils.js). Any position DELTA on a new patch
  re-arms a 150ms hold; movement is true until the hold expires — that spans two
  patch gaps (150ms >> 50ms) so the flag never flaps mid-swing. A stopped caster
  stops getting deltas and the hold decays to 0, snapping back to a pure swing.
  Pinned by the RC9 block in `test/strafeRootSkill.test.mjs`.

## SKILL — every character shares the J melee but casts its own K skill

- **Requirement**: all characters have the same normal attack (J); each casts a
  DIFFERENT skill (K).
- **Design**: `src/shared/skills.js` holds `SKILLS` (one per class: Whirlwind /
  Piercing Shot / Arcane Nova / Frenzy Slam) + pure `resolveSkillHits()`
  (`aoe` = everything in a radius; `cone` = within range + facing arc). The
  server enforces cooldown/damage authoritatively (`castSkill`) and shows
  `anim='skill'` for `animUntil`, but the caster keeps MOVING through the cast
  (RC7); the client plays the class swing time-scaled to the skill window,
  spawns a colored burst, and shows a skill cooldown bar. Pinned by
  `test/strafeRootSkill.test.mjs`.

  frame rate.
