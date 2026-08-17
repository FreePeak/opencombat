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
  frame rate.
