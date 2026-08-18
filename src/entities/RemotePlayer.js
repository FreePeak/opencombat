// Remote player view: the shared character model tinted per player (the
// server-assigned color), lerping toward the latest server state. State
// patches arrive at ~20Hz; the lerp hides the steps (simple interpolation,
// per spec). Power-up effects render from PlayerState.effects, and the
// nametag div (name + HP) is updated by GameScene.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { attachWeapon, ProceduralAnim } from './Sword.js';
import { CONFIG } from '../config.js';
import { attackTimeScale, frameDamp, MOVING_ATTACK_RUN_BLEND, ACTION_BLEND, remoteMoveHold, SPAWN_DRAW_S } from '../anim/AnimUtils.js';
import { skillFor } from '../shared/skills.js';

export default class RemotePlayer {
  constructor(scene, state, model, def, color, swordModel = null) {
    this.state = state; // live PlayerState ref, patched by colyseus
    this.def = def;
    this.skillDef = skillFor(state.character); // the class's K skill (for anim timing)
    this.baseColor = new THREE.Color(color);

    this.root = new THREE.Group();
    this.root.scale.setScalar(def.scale);
    // SkeletonUtils.clone: skinned GLB — see Player.js for why.
    this.mesh = skeletonClone(model.scene);
    this.materials = [];
    this.mesh.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.material.color.copy(this.baseColor);
      o.castShadow = true;
      this.materials.push(o.material);
    });
    this.root.add(this.mesh);
    // Per-class weapon, same as the local player.
    this.weapon = attachWeapon(this.mesh, def, swordModel);
    scene.add(this.root);

    // SHIELD bubble, hidden until the effect is active.
    this.shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.15, 16, 12),
      new THREE.MeshBasicMaterial({
        color: CONFIG.effects.shield.color,
        transparent: true,
        opacity: CONFIG.effects.shield.sphereOpacity,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    this.shieldMesh.visible = false;
    this.root.add(this.shieldMesh);

    // BLOCK guard: translucent wall in front while the server says the player
    // is holding L (same visual as the local player's prediction).
    this.guardMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 1.6, 0.12),
      new THREE.MeshBasicMaterial({
        color: CONFIG.effects.block.color,
        transparent: true,
        opacity: CONFIG.effects.block.opacity,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    this.guardMesh.position.set(0, 0.9, 0.85);
    this.guardMesh.visible = false;
    this.root.add(this.guardMesh);

    this.mixer = new THREE.AnimationMixer(this.mesh);
    this.clips = {};
    for (const [name, clipName] of Object.entries(def.anims)) {
      if (!clipName) continue;
      const clip = THREE.AnimationClip.findByName(model.animations, clipName);
      if (clip) this.clips[name] = this.mixer.clipAction(clip);
    }
    // RC10: actions start once, blending happens with eased weights only.
    this.currentName = 'idle';
    this.wAtk = 0;
    this.wRun = 0;
    this.wIdle = this.clips.idle ? 1 : 0;
    for (const action of Object.values(this.clips)) {
      action.setEffectiveWeight(0);
      action.play();
    }
    // Attack clip plays once then clamps — LoopOnce at construction makes
    // the SPAWN DRAW below a true one-shot that can never loop under idle.
    if (this.clips.attack) {
      this.clips.attack.setLoop(THREE.LoopOnce);
      this.clips.attack.clampWhenFinished = true;
    }
    if (this.clips.idle) this.clips.idle.setEffectiveWeight(1);
    // Draw-sword once on spawn (same gesture the local player sees on their
    // own knight); afterwards idle/run play clean with no attack residue.
    this.drawT = this.clips.attack ? SPAWN_DRAW_S : 0;
    this.proc = Object.keys(this.clips).length ? null : new ProceduralAnim(this.root, this.weapon);

    // RC9: fetch the server patch position so a "moving" hold can be armed
    // when the caster's position actually changes (stable across the 20Hz gap).
    this.move = { sx: state.x, sz: state.z, hold: 0 };

    // Snap to the spawn position once; afterwards we only lerp.
    this.root.position.set(state.x, 0, state.z);
    this.root.rotation.y = state.rotY;
  }

  /**
   * RC8/RC9/RC10 clip driver for remote players (mirrors Player.updateClipAnims).
   * The server drives `anim`; whether the caster is moving is decided by RC9's
   * patch-delta hold (`this.moveHold`), NOT by per-frame lerp position, whose
   * lead decays below any threshold between the ~20Hz patches and would flicker
   * the run blend mid-swing. RC10: all weights are EASED toward their targets
   * (~100ms crossfades) — swings blend in/out instead of snapping, matching
   * what the local player sees on their own character.
   */
  updateClipAnims(_dt, moving) {
    const s = this.state;
    const casting = s.anim === 'skill';
    const swinging = casting || s.anim === 'attack';
    const atk = this.clips.attack;
    const run = this.clips.run;
    const idle = this.clips.idle;

    // Target weights for this frame.
    let tAtk = 0, tRun = 0, tIdle = 0;
    if (swinging && atk) {
      tAtk = 1;
      if (moving && run) tRun = MOVING_ATTACK_RUN_BLEND;
      if (this.currentName !== s.anim) {
        this.currentName = s.anim;
        atk.reset();
        atk.setLoop(THREE.LoopOnce);
        atk.clampWhenFinished = true;
        // RC2: same time-scaled swing as the local player, so a remote knight
        // shows the full arc inside the server's attackAnimMs window.
        atk.timeScale = attackTimeScale(atk.getClip(),
          casting ? this.skillDef.animMs : CONFIG.player.attackAnimMs);
        atk.play();
      }
    } else if (this.drawT > 0 && atk) {
      // One-time spawn draw: full-weight single playthrough of the clip,
      // legs blending under it when the remote is already moving.
      tAtk = 1;
      if (moving && run) tRun = MOVING_ATTACK_RUN_BLEND;
      this.currentName = 'draw';
    } else if (moving && run) {
      tRun = 1;
      this.currentName = 'run';
    } else {
      tIdle = 1;
      this.currentName = 'idle';
    }

    // Ease every weight toward its target (frame-rate independent, RC4).
    const e = frameDamp(ACTION_BLEND, _dt);
    this.wAtk += (tAtk - this.wAtk) * e;
    this.wRun += (tRun - this.wRun) * e;
    this.wIdle += (tIdle - this.wIdle) * e;
    atk?.setEffectiveWeight(this.wAtk);
    run?.setEffectiveWeight(this.wRun);
    idle?.setEffectiveWeight(this.wIdle);
  }

  updateEffects(effects) {
    const hasShield = effects?.has?.('shield') ?? false;
    this.shieldMesh.visible = hasShield;
    const hasDouble = effects?.has?.('double') ?? false;
    const tint = hasDouble ? new THREE.Color(CONFIG.effects.double.color) : this.baseColor;
    for (const m of this.materials) m.color.copy(tint);
  }

  update(dt) {
    const s = this.state;
    this.drawT = Math.max(0, this.drawT - dt);
    // Guard wall follows the server's blocking flag.
    this.guardMesh.visible = !!s.blocking;
    // Lerp toward the last received position to avoid jitter. RC4: the old
    // fixed `* 0.25` only converged correctly at 60fps; frameDamp keeps the
    // tuned feel while converging identically at any frame rate.
    const t = frameDamp(0.25, dt);
    this.root.position.x += (s.x - this.root.position.x) * t;
    this.root.position.z += (s.z - this.root.position.z) * t;
    // rotY lerp through the shortest angle.
    let dy = s.rotY - this.root.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.root.rotation.y += dy * t;
    if (this.proc) {
      // Clip-less model: drive the bob/swing from the server anim name.
      this.proc.update(dt, s.anim === 'run', s.anim === 'attack' || s.anim === 'skill');
    } else {
      // RC9: moving = anim says 'run' OR the position keeps changing (patch
      // delta), with a hold so it cannot flicker between the ~20Hz patches.
      this.moveHold = remoteMoveHold(s.x, s.z, this.move, dt);
      const moving = s.anim === 'run' || this.moveHold > 0;
      this.updateClipAnims(dt, moving); // server-driven anim (idle/run/attack/skill)
      this.mixer.update(dt);
    }
    this.updateEffects(s.effects);
  }

  dispose() {
    this.root.parent?.remove(this.root);
  }
}
