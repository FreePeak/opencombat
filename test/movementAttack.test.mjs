// TDD suite for "character movement/attack is not smooth and not correct".
//
// Root-cause evidence (documented in ROOT_CAUSES.md):
//   RC1  knight_mixamo.glb clips bake ROOT MOTION into the Hips bone
//        (Attack: Hips translation sweeps ~18x17 units; Idle ~9x6; Run a 280
//        unit vertical swing). The server owns x/z, so the animated hips
//        drag the mesh away from its lerped position -> the knight slides/
//        swims in directions nobody steered. The three legacy characters
//        (archer/mage/demon) animate no root bone translation and are fine.
//   RC2  The Attack clip is 1.433s but the server (and client) show the
//        attack for attackAnimMs = 350ms. playAnim() plays the clip at 1x
//        and switches back to idle after 350ms -> the player sees ~24% of
//        the swing (wind-up only) before it hard-cuts back to idle.
//   RC3  Player.update sends input throttled at 30Hz with a lastSent diff,
//        but the `attack` edge is true for only ONE frame. If that frame
//        does not coincide with a send slot, the diff sees attack:false on
//        the next slot and the J press is silently dropped.
//   RC4  RemotePlayer/Enemy lerp with a fixed per-frame factor (0.25/0.2),
//        which is frame-rate dependent: at 30fps they converge 2x slower,
//        at 120fps 2x faster, so remote motion looks smoother or jerky
//        depending on the machine, and the local camera lerp (0.08) too.
//
// The contract tests below FAIL until src/anim/AnimUtils.js exists and
// Player.js / RemotePlayer.js / Enemy.js / GameScene.js are rewired.
// Run: node test/movementAttack.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  findRootMotionClip, stripRootMotion, attackTimeScale,
  dampFactor, frameDamp, shouldSendInput, subclipAnims
} from '../src/anim/AnimUtils.js';

const here = dirname(fileURLToPath(import.meta.url));
const KNIGHT = join(here, '..', 'assets', 'characters', 'knight_mixamo.glb');
const ARCHER = join(here, '..', 'assets', 'characters', 'archer.glb');

// Headless-browser shims: GLTFLoader touches `self` and decodes textures
// through createImageBitmap even though the tests only read animation
// tracks — the pixels are never rendered.
globalThis.self = globalThis;
globalThis.createImageBitmap ||= (async () => ({ width: 1, height: 1 }));

// Load a GLB in node: GLTFLoader.parse accepts a raw ArrayBuffer.
function loadGlb(path) {
  const buf = fs.readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  return new Promise((res, rej) => loader.parse(ab, '', res, rej));
}

const knight = await loadGlb(KNIGHT);
const archer = await loadGlb(ARCHER);
assert.ok(knight.animations.length >= 3, 'knight GLB ships its three clips');

// --- RC1: root-motion detection + removal ---------------------------------
// The raw asset MUST be reported as carrying root motion (this is the bug
// the renderer trips over); the stripped clips must not move the hips.
for (const name of ['CharacterArmature|Attack', 'CharacterArmature|Idle', 'CharacterArmature|Run']) {
  const clip = THREE.AnimationClip.findByName(knight.animations, name);
  assert.ok(clip, `knight clip ${name} exists`);
  assert.ok(findRootMotionClip(clip), `RC1 evidence: ${name} bakes root motion into the hips`);
}
for (const clip of archer.animations) {
  assert.ok(!findRootMotionClip(clip), `legacy clip ${clip.name} has no root motion (contract)`);
}

const stripped = stripRootMotion(knight.animations);
assert.equal(stripped.length, knight.animations.length, 'stripRootMotion keeps every clip');
for (const clip of stripped) {
  assert.ok(!findRootMotionClip(clip), `stripped clip ${clip.name} no longer animates the hips`);
  assert.ok(clip.tracks.length > 0 && clip.duration > 0, `stripped clip ${clip.name} keeps its pose tracks`);
  for (const track of clip.tracks) {
    assert.ok(!/mixamorig:Hips\.position$/.test(track.name), 'no hips position track survives');
  }
}
// Stripping must be idempotent and leave clean clips untouched.
const stripped2 = stripRootMotion(stripped);
assert.deepEqual(stripped2.map((c) => c.tracks.length), stripped.map((c) => c.tracks.length),
  'stripRootMotion is idempotent');
const archerStripped = stripRootMotion(archer.animations);
assert.equal(archerStripped, archer.animations, 'clean clips pass through by reference');

// --- RC2: the attack clip must finish inside attackAnimMs ------------------
// attackTimeScale(clip, ms) = clip.duration / (ms/1000): at that rate a
// mixer reaches the end of the swing exactly when the server stops showing
// anim='attack'. Verified with a real AnimationMixer.
const ATTACK_MS = 350; // mirrors SERVER.player.attackAnimMs / CONFIG.player.attackAnimMs
for (const name of ['CharacterArmature|Attack', 'CharacterArmature|Sword_Slash']) {
  const src = name === 'CharacterArmature|Attack' ? knight : archer;
  const clip = THREE.AnimationClip.findByName(src.animations, name);
  const rate = attackTimeScale(clip, ATTACK_MS);
  assert.ok(rate > 1, `${name} (${clip.duration.toFixed(2)}s) must play faster than 1x to fit 350ms`);

  const mixer = new THREE.AnimationMixer(new THREE.Object3D());
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce);
  action.timeScale = rate;
  action.reset().play();
  let elapsed = 0;
  const dt = 1 / 60;
  while (!mixer.timeScale && elapsed < 2) { mixer.update(dt); elapsed += dt; if (action.paused) break; }
  // LoopOnce pauses the action at the last frame; allow a one-frame margin.
  assert.ok(elapsed <= ATTACK_MS / 1000 + dt,
    `${name} completed within attackAnimMs (took ${elapsed.toFixed(3)}s)`);
}

// --- RC3: the attack edge must survive the 30Hz send throttle --------------
// shouldSendInput(last, next) is the single predicate Player uses. It must
// report a diff while an attack EDGE is pending, even when dirX/dirZ/anim
// all equal the last sent values.
const base = { dirX: 0, dirZ: 0, attack: false, anim: 'idle' };
assert.equal(shouldSendInput(base, { ...base }), false, 'identical input is not re-sent');
assert.equal(shouldSendInput(base, { ...base, dirX: 1 }), true, 'dir change is sent');
assert.equal(shouldSendInput(base, { ...base, attack: true }), true,
  'RC3: a pending attack edge is sent even when everything else is unchanged');
assert.equal(shouldSendInput({ ...base, attack: true }, { ...base, attack: true }), false,
  'a held attack flag is not spammed');

// --- RC4: smoothing must be frame-rate independent -------------------------
// dampFactor(k, dt): remaining distance after T seconds is exp(-k*T) no
// matter how the frames subdivide it. The old code was `* 0.25` per frame,
// which only matches at exactly 60fps.
const converge = (dtOf, total) => {
  let dist = 1;
  let t = 0;
  while (t < total - 1e-9) { const dt = dtOf(); dist -= dist * 0; dist *= (1 - dampFactor(20, dt)); t += dt; }
  return dist;
};
const T = 0.5, k = 20, expected = Math.exp(-k * T);
assert.ok(Math.abs(converge(() => 1 / 60, T) - expected) < 1e-3, 'dampFactor exact at 60fps');
assert.ok(Math.abs(converge(() => 1 / 30, T) - expected) < 1e-3, 'dampFactor exact at 30fps');
assert.ok(Math.abs(converge(() => 1 / 144, T) - expected) < 1e-3, 'dampFactor exact at 144fps');
assert.ok(Math.abs(converge(() => 1 / 60 + (Math.random() - 0.5) * 0.004, T) - expected) < 2e-3,
  'dampFactor exact under jitter');
// frameDamp keeps the legacy per-frame factor semantics rate-corrected:
// 60fps frames of frameDamp(0.25, dt) reproduce (1-0.25)^n exactly.
assert.ok(Math.abs(frameDamp(0.25, 1 / 60) - 0.25) < 1e-9, 'frameDamp(p, 1/60) == p (continuity)');
const f30 = frameDamp(0.25, 1 / 30);
assert.ok(Math.abs((1 - f30) - 0.75 * 0.75) < 1e-9, 'frameDamp(p, 1/30) == 1-(1-p)^2');

// --- subclipAnims: trim problem content out of the knight's clips ---------
// The knight's Attack clip is 1.433s — 1.07s is a static raised-sword pose;
// only the last ~0.33s is the visible slash. subclipAnims trims to that
// window so each attack is one swing, not a repeated draw loop. The Idle
// clip (1.5s) embeds a big arm gesture (a "draw") between t≈0.3–1.15s before
// settling — subclipAnims also trims it to the calm settled stance so the
// loop cannot replay the draw while standing still.
{
  // Characters WITH attackSubclip: the attack clip is trimmed.
  const knightAnims = knight.animations;
  const trimmed = subclipAnims(knightAnims, {
    attackSubclip: { startFrame: 65, endFrame: 86, fps: 60 },
    anims: { attack: 'CharacterArmature|Attack' }
  });
  const trimmedAttack = trimmed.find(c => c.name.includes('Attack'));
  const origAttack = knightAnims.find(c => c.name.includes('Attack'));
  assert.ok(trimmedAttack !== origAttack, 'subclipAnims returns a new clip (clone)');
  assert.equal(trimmedAttack.name, origAttack.name, 'trimmed clip keeps original name');
  // Duration = (86 - 65) / 60 = 0.35s (endFrame exclusive)
  assert.ok(Math.abs(trimmedAttack.duration - 0.35) < 0.02,
    `trimmed attack duration ~0.35s, got ${trimmedAttack.duration.toFixed(3)}`);
  assert.ok(trimmedAttack.duration < origAttack.duration * 0.3,
    'trimmed clip is under 30% of original (static hold removed)');
  // Idle and Run are untouched when only attackSubclip is set.
  assert.equal(trimmed.find(c => c.name.includes('Idle')), knightAnims.find(c => c.name.includes('Idle')),
    'Idle clip is not modified without idleSubclip');
  assert.equal(trimmed.find(c => c.name.includes('Run')), knightAnims.find(c => c.name.includes('Run')),
    'Run clip is not modified');
  // attackTimeScale now produces a ≤1x speed (the slash fits the window).
  const scale = attackTimeScale(trimmedAttack, 450);
  assert.ok(scale <= 1.2,
    `attackTimeScale with trimmed clip ≤ 1.2x (full-speed visible swing), got ${scale.toFixed(3)}`);
}

{
  // idleSubclip trims the Idle clip to its calm settled loop (frames 77–90;
  // startFrame 76 compensates fp32 key quantization — see config.js).
  // Mirrors the real pipeline: stripRootMotion first, then subclipAnims.
  const knightAnims = stripRootMotion(knight.animations);
  const trimmed = subclipAnims(knightAnims, {
    idleSubclip: { startFrame: 76, endFrame: 91, fps: 60 },
    anims: { idle: 'CharacterArmature|Idle' }
  });
  const trimmedIdle = trimmed.find(c => c.name.includes('Idle'));
  const origIdle = knightAnims.find(c => c.name.includes('Idle'));
  assert.ok(trimmedIdle !== origIdle, 'idle clip with idleSubclip is cloned');
  // Duration = (90 - 77) / 60 ≈ 0.217s (kept keys; endFrame exclusive)
  assert.ok(Math.abs(trimmedIdle.duration - 13 / 60) < 0.02,
    `trimmed idle duration ~0.217s, got ${trimmedIdle.duration.toFixed(3)}`);
  // The trim drops the gesture keys: every track's value range in the
  // trimmed clip must be tiny (calm stance), far below the full clip's.
  const trackMaxRange = (clip) => {
    let m = 0;
    for (const t of clip.tracks) {
      const n = t.getValueSize();
      for (let a = 0; a < n; a++) {
        let lo = Infinity, hi = -Infinity;
        for (let i = a; i < t.values.length; i += n) {
          lo = Math.min(lo, t.values[i]); hi = Math.max(hi, t.values[i]);
        }
        m = Math.max(m, hi - lo);
      }
    }
    return m;
  };
  assert.ok(trackMaxRange(trimmedIdle) < 0.15,
    'trimmed idle is the calm window (all bone deltas small)');
  assert.ok(trackMaxRange(origIdle) > 0.5,
    'original idle contains the big gesture (sanity: trim was needed)');
  // Attack is untouched when only idleSubclip is set.
  assert.equal(trimmed.find(c => c.name.includes('Attack')), knightAnims.find(c => c.name.includes('Attack')),
    'Attack clip is not modified without attackSubclip');
}

{
  // Characters WITHOUT any subclip config: passes through unchanged.
  const passThrough = subclipAnims(archer.animations, {
    anims: { attack: 'CharacterArmature|Punch' }
  });
  assert.deepEqual(passThrough, archer.animations,
    'no subclip config → animations pass through unchanged');
}

{
  // null / undefined animations: safe pass-through.
  assert.equal(subclipAnims(null, { attackSubclip: {} }), null);
  assert.equal(subclipAnims(undefined, {}), undefined);
  assert.equal(subclipAnims(archer.animations, undefined), archer.animations,
    'undefined def passes through');
}

console.log('ok — movementAttack.test.mjs: all root-cause contracts pass');
