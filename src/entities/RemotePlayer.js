// Remote player view: the shared character model tinted per player (the
// server-assigned color), lerping toward the latest server state. State
// patches arrive at ~20Hz; the lerp hides the steps (simple interpolation,
// per spec). Power-up effects render from PlayerState.effects, and the
// nametag div (name + HP) is updated by GameScene.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { attachWeapon, ProceduralAnim } from './Sword.js';
import { CONFIG } from '../config.js';
import { attackTimeScale, frameDamp, MOVING_ATTACK_RUN_BLEND, remoteMoveHold } from '../anim/AnimUtils.js';
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

    this.mixer = new THREE.AnimationMixer(this.mesh);
    this.clips = {};
    for (const [name, clipName] of Object.entries(def.anims)) {
      if (!clipName) continue;
      const clip = THREE.AnimationClip.findByName(model.animations, clipName);
      if (clip) this.clips[name] = this.mixer.clipAction(clip);
    }
    this.proc = Object.keys(this.clips).length ? null : new ProceduralAnim(this.root, this.weapon);
    this.playAnim('idle');

    // RC9: fetch the server patch position so a "moving" hold can be armed
    // when the caster's position actually changes (stable across the 20Hz gap).
    this.move = { sx: state.x, sz: state.z, hold: 0 };

    // Snap to the spawn position once; afterwards we only lerp.
    this.root.position.set(state.x, 0, state.z);
    this.root.rotation.y = state.rotY;
  }

  playAnim(name) {
    // The skill cast reuses the class's swing clip (no separate skill clip).
    const clipKey = name === 'skill' ? 'attack' : name;
    const action = this.clips[clipKey];
    if (!action || (action === this.current && this.currentName === name)) return;
    this.current = action;
    this.currentName = name;
    this.mixer.stopAllAction();
    action.reset().play();
    // RC2: same time-scaled swing as the local player, so a remote knight
    // shows the full arc inside the server's attackAnimMs window.
    if (name === 'attack') {
      action.timeScale = attackTimeScale(action.getClip(), CONFIG.player.attackAnimMs);
      action.setLoop(THREE.LoopOnce);
      action.clampWhenFinished = true;
    } else if (name === 'skill') {
      action.timeScale = attackTimeScale(action.getClip(), this.skillDef.animMs);
      action.setLoop(THREE.LoopOnce);
      action.clampWhenFinished = true;
    } else {
      action.timeScale = 1;
      action.setLoop(THREE.LoopRepeat);
    }
  }

  /**
   * RC8/RC9 clip driver for remote players (mirrors Player.updateClipAnims).
   * The server drives `anim`; whether the caster is moving is decided by RC9's
   * patch-delta hold (`this.moveHold`), NOT by per-frame lerp position, whose
   * lead decays below any threshold between the ~20Hz patches and would flicker
   * the run blend mid-swing.
   */
  updateClipAnims(_dt, moving) {
    const s = this.state;
    const swinging = s.anim === 'attack' || s.anim === 'skill';
    const casting = s.anim === 'skill';
    const atk = this.clips.attack;
    const run = this.clips.run;
    const idle = this.clips.idle;

    if (swinging && atk) {
      const name = s.anim;
      if (this.currentName !== name) {
        this.currentName = name;
        atk.reset();
        atk.setLoop(THREE.LoopOnce);
        atk.clampWhenFinished = true;
        atk.timeScale = attackTimeScale(atk.getClip(),
          casting ? this.skillDef.animMs : CONFIG.player.attackAnimMs);
        atk.play();
      }
      const runW = moving && run ? MOVING_ATTACK_RUN_BLEND : 0;
      atk.setEffectiveWeight(1 - runW);
      if (run) {
        if (runW > 0) {
          if (!run.isRunning()) { run.setLoop(THREE.LoopRepeat); run.timeScale = 1; run.play(); }
          run.setEffectiveWeight(runW);
        } else run.setEffectiveWeight(0);
      }
      if (idle) idle.setEffectiveWeight(0);
    } else {
      if (atk) atk.setEffectiveWeight(0);
      const loco = moving ? run : idle;
      const other = moving ? idle : run;
      if (loco) {
        if (!loco.isRunning()) { loco.setLoop(THREE.LoopRepeat); loco.timeScale = 1; loco.play(); }
        loco.setEffectiveWeight(1);
      }
      if (other) other.setEffectiveWeight(0);
      this.currentName = moving ? 'run' : 'idle';
    }
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
