// Remote player view: the shared character model tinted per player (the
// server-assigned color), lerping toward the latest server state. State
// patches arrive at ~20Hz; the lerp hides the steps (simple interpolation,
// per spec). Power-up effects render from PlayerState.effects, and the
// nametag div (name + HP) is updated by GameScene.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { attachWeapon, ProceduralAnim } from './Sword.js';
import { CONFIG } from '../config.js';

export default class RemotePlayer {
  constructor(scene, state, model, def, color, swordModel = null) {
    this.state = state; // live PlayerState ref, patched by colyseus
    this.def = def;
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

    // Snap to the spawn position once; afterwards we only lerp.
    this.root.position.set(state.x, 0, state.z);
    this.root.rotation.y = state.rotY;
  }

  playAnim(name) {
    const action = this.clips[name];
    if (!action || action === this.current) return;
    this.current = action;
    this.mixer.stopAllAction();
    action.reset().play();
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
    // Lerp toward the last received position to avoid jitter.
    this.root.position.x += (s.x - this.root.position.x) * 0.25;
    this.root.position.z += (s.z - this.root.position.z) * 0.25;
    // rotY lerp through the shortest angle.
    let dy = s.rotY - this.root.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.root.rotation.y += dy * 0.25;
    if (this.proc) {
      // Clip-less model: drive the bob/swing from the server anim name.
      this.proc.update(dt, s.anim === 'run', s.anim === 'attack');
    } else {
      this.playAnim(s.anim); // server-driven anim (idle/run/attack)
      this.mixer.update(dt);
    }
    this.updateEffects(s.effects);
  }

  dispose() {
    this.root.parent?.remove(this.root);
  }
}
