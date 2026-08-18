// Animation/render math shared by the movement/attack smoothness fixes.
// Every function here is pinned by a contract test in
// test/movementAttack.test.mjs; see ROOT_CAUSES.md for the bugs they fix.
//
//   RC1  findRootMotionClip / stripRootMotion  — Mixamo clips bake ROOT
//        MOTION into the hips bone; the server owns x/z so the animated
//        hips drag the mesh away from its lerped position (the knight
//        slides/swims). Stripping the offending position tracks keeps the
//        skeleton pose but removes the baked displacement.
//   RC2  attackTimeScale — the attack clip is longer than the window the
//        server shows it for; playing it at 1x hard-cuts at the wind-up.
//   RC3  shouldSendInput — the attack edge is one frame; it must survive
//        the 30Hz send throttle instead of being diffed away.
//   RC4  dampFactor / frameDamp — exponential smoothing that converges at
//        the same rate no matter how frames subdivide time (the old
//        `* 0.25` per frame only matched at exactly 60fps).
//   RC5  cameraMoveDir / cameraOffset — map movement + the camera rig onto a
//        FIXED azimuth instead of the character's own yaw, so A/D strafes in a
//        straight line and the camera can no longer orbit round and round.
import * as THREE from 'three';
import { AnimationUtils } from 'three';

// Translation range (in clip units) below which a bone position track is
// considered cosmetic jitter rather than baked root motion. Measured margin
// (see ROOT_CAUSES.md): legacy Quaternius rigs wiggle feet/bones by up to
// ~0.02 units, while the Mixamo knight's hips sweep 8.6+ units — 0.1 sits
// comfortably between the two populations.
const ROOT_MOTION_EPS = 0.1;

/** Max axis range of a track's value buffer (units of the animated property). */
function trackRange(track) {
  const n = track.getValueSize();
  let max = 0;
  for (let axis = 0; axis < n; axis++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = axis; i < track.values.length; i += n) {
      const v = track.values[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    max = Math.max(max, hi - lo);
  }
  return max;
}

function isRootMotionTrack(track) {
  return track.name.endsWith('.position') && trackRange(track) > ROOT_MOTION_EPS;
}

/**
 * Return the first root-motion position track baked into the clip, or null.
 * RC1 detector: a non-null result means playing this clip would translate
 * the skeleton — which the server-authoritative renderer must not do.
 */
export function findRootMotionClip(clip) {
  return clip.tracks.find(isRootMotionTrack) || null;
}

/**
 * Copy of `clips` with every root-motion position track removed (RC1).
 * Clips without root motion pass through by reference, so stripping is
 * idempotent and clean assets share buffers with the loaded GLB.
 */
export function stripRootMotion(clips) {
  let changed = false;
  const out = clips.map((clip) => {
    if (!findRootMotionClip(clip)) return clip;
    changed = true;
    const tracks = clip.tracks.filter((t) => !isRootMotionTrack(t));
    return new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
  });
  return changed ? out : clips;
}

/**
 * Playback rate that squeezes the whole `clip` into `animMs` of wall time
 * (RC2): the swing arc lands exactly when the server stops showing
 * anim='attack' instead of cutting off at the wind-up.
 */
export function attackTimeScale(clip, animMs) {
  return clip.duration / (animMs / 1000);
}

/**
 * Single predicate for the 30Hz input throttle (RC3). Identical intents are
 * not re-sent; any dir/anim change is; and an attack EDGE (false -> true or
 * true -> false) always counts as a change even when dirX/dirZ/anim are all
 * unchanged — the edge is one frame and must never be diffed away. The HELD
 * block flag is diffed too, so raising/dropping the guard reaches the server
 * immediately.
 */
export function shouldSendInput(last, next) {
  return (
    next.dirX !== last.dirX ||
    next.dirZ !== last.dirZ ||
    next.anim !== last.anim ||
    next.attack !== last.attack ||
    next.skill !== last.skill ||
    next.block !== last.block
  );
}

/**
 * Exponential damping factor with rate constant k (RC4): after T seconds the
 * remaining distance is exp(-k*T) regardless of how frames subdivide T.
 * Use as `x += (target - x) * dampFactor(k, dt)`.
 */
export function dampFactor(k, dt) {
  return 1 - Math.exp(-k * dt);
}

/**
 * Frame-rate-independent version of a legacy per-frame lerp factor `p`
 * calibrated at 60fps (RC4): frameDamp(p, dt) = 1 - (1-p)^(dt*60). Keeps the
 * tuned look at 60fps while converging at the same rate on 30/144Hz screens.
 */
export function frameDamp(p, dt) {
  return 1 - Math.pow(1 - p, dt * 60);
}

/**
 * RC5: camera-relative movement basis. Maps input axes onto a FIXED camera
 * azimuth (camYaw) instead of the character's own yaw. ix = right(+)/left(-),
 * iz = forward(+)/back(-). Because camYaw never tracks the character's facing,
 * holding A or D strafes along a constant world direction — the old
 * character-relative mapping re-pointed the mover at its velocity each tick,
 * curving A/D into a circle ("camera going round and round").
 *   screen-forward = (sin, cos); screen-right = cross(forward, up) = (-cos, sin)
 * @returns {{x:number, z:number}} world-space movement direction
 */
export function cameraMoveDir(ix, iz, camYaw) {
  const s = Math.sin(camYaw);
  const c = Math.cos(camYaw);
  return { x: s * iz - c * ix, z: c * iz + s * ix };
}

/**
 * RC5: horizontal offset from the followed target to the camera for a fixed
 * azimuth. The camera sits `distance` behind the target along camYaw and never
 * references the character's rotation, so the rig cannot orbit. Pair with
 * cameraMoveDir so W always runs directly away from the camera.
 * @returns {{x:number, z:number}} offset to ADD to the target position
 */
export function cameraOffset(camYaw, distance) {
  return { x: -Math.sin(camYaw) * distance, z: -Math.cos(camYaw) * distance };
}

// RC8: while attacking ON THE MOVE, blend this much of the run cycle under the
// swing so the legs keep stepping — removing the planted-feet "skate/slide" and
// the hard pop when the swing ends. 0 = pure swing, 1 = pure run.
export const MOVING_ATTACK_RUN_BLEND = 0.42;

// RC10 (combat feel): per-frame weight easing factor (calibrated at 60fps)
// for the clip blender in Player/RemotePlayer. Every animation weight moves
// toward its target through frameDamp(ACTION_BLEND, dt) — a ~100ms crossfade
// — instead of snapping 0 <-> blend <-> 1 in one frame, which made each
// swing start and end with a visible pop.
export const ACTION_BLEND = 0.5;

// One-time draw-sword on spawn: the attack clip plays once at full weight
// while this window counts down (~100ms fade-in + the 0.35s trimmed slash +
// margin), then idle/run take over CLEAN — the drawn stance is a spawn
// gesture, not the default look.
export const SPAWN_DRAW_S = 0.55;

// RC9: how long a remote player is treated as "moving" after ANY server
// position patch delta. Server patches arrive at ~20Hz (SERVER.tickMs = 50), so
// a per-frame lerp-lead check (root trailing the target) decays below its
// threshold BETWEEN patches and makes the RC8 run blend flicker on/off ~20x/s
// during a moving swing. A patch delta re-arms this hold; the flag stays true
// until the hold expires, which comfortably spans two patch gaps (150ms >> 50ms).
export const REMOTE_MOVE_HOLD = 0.15;

/**
 * RC9: arm/hold the remote "is moving" flag against server position patches.
 * `carry` is a mutable cursor ({ sx, sz, hold }) owned by the RemotePlayer so
 * consecutive frames accumulate. Any delta in a NEW patch re-arms the hold to
 * REMOTE_MOVE_HOLD; otherwise the hold decays by dt. Returns the hold seconds.
 */
export function remoteMoveHold(sx, sz, carry, dt) {
  const moved = Math.abs(sx - carry.sx) > 1e-4 || Math.abs(sz - carry.sz) > 1e-4;
  carry.sx = sx;
  carry.sz = sz;
  carry.hold = moved ? REMOTE_MOVE_HOLD : Math.max(0, (carry.hold || 0) - dt);
  return carry.hold;
}

/**
 * Trim per-character clips at load time when the shipped GLB clip contains
 * content that must not play in-game, keyed by `def`:
 *
 *   def.attackSubclip — keep only the active phase of the attack clip (the
 *     knight's Attack is a 1.07s static raised-sword hold + slash; trimming
 *     made each attack one visible swing instead of a repeated draw loop).
 *   def.idleSubclip — keep only the calm settled phase of the idle clip.
 *     The knight's "Idle" is NOT a calm loop: between t≈0.3s and t≈1.15s the
 *     right arm sweeps through a large sword-draw-like gesture (RightArm
 *     quaternion y swings −0.03 → −0.68 → back, elbow bends −0.29 → −0.70),
 *     and the clip LOOPS every 1.5s — so standing still replayed the draw
 *     after every attack/run. Frames 77–90 (t=1.283–1.5) are the settled
 *     stance: every bone's rotation delta there is ≤ ~0.09 (vs ~1.2 peak).
 *
 * AnimationUtils.subclip clones the clip and shifts keyframe times to t=0
 * so the trimmed clip plays naturally from the start.
 */
const SUBCLIP_FRAGMENTS = ['Attack', 'Idle', 'Run'];

export function subclipAnims(animations, def) {
  if (!animations || !def) return animations;
  let changed = false;
  const out = animations.map((clip) => {
    const frag = SUBCLIP_FRAGMENTS.find((f) => clip.name.includes(f));
    if (!frag) return clip;
    const sub = def[frag.toLowerCase() + 'Subclip'];
    if (!sub) return clip;
    changed = true;
    return AnimationUtils.subclip(clip, clip.name, sub.startFrame, sub.endFrame, sub.fps);
  });
  return changed ? out : animations;
}
