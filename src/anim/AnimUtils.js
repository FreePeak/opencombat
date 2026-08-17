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
import * as THREE from 'three';

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
 * unchanged — the edge is one frame and must never be diffed away.
 */
export function shouldSendInput(last, next) {
  return (
    next.dirX !== last.dirX ||
    next.dirZ !== last.dirZ ||
    next.anim !== last.anim ||
    next.attack !== last.attack
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
