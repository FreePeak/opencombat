// Remote player view: the shared character model tinted per player (the
// server-assigned color), lerping toward the latest server state. State
// patches arrive at ~20Hz; the lerp hides the steps (simple interpolation,
// per spec). Power-up effects render from PlayerState.effects, and the
// nametag div (name + HP) is updated by GameScene.
import * as THREE from 'three';
import { CONFIG } from '../config.js';

export default class RemotePlayer {
  constructor(scene, state, model, anims, color, scale = 1) {
    this.state = state; // live PlayerState ref, patched by colyseus
    this.baseColor = new THREE.Color(color);

    this.root = new THREE.Group();
    this.root.scale.setScalar(scale);
    const mesh = model.clone(true);
    this.materials = [];
    mesh.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.material.color.copy(this.baseColor);
      o.castShadow = true;
      this.materials.push(o.material);
    });
    this.root.add(mesh);
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

    this.mixer = new THREE.AnimationMixer(mesh);
    this.clips = {};
    for (const [name, clipName] of Object.entries(CONFIG.anims.player)) {
      const clip = THREE.AnimationClip.findByName(anims, clipName);
      if (clip) this.clips[name] = this.mixer.clipAction(clip);
    }
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
    this.playAnim(s.anim); // server-driven anim (idle/run/attack)
    this.updateEffects(s.effects);
    this.mixer.update(dt);
  }

  dispose() {
    this.root.parent?.remove(this.root);
  }
}
