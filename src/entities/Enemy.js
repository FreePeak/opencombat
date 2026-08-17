// Enemy view: renders the server-side enemy state. All logic (chase,
// damage, death, respawn) happens in GameRoom — this class only lerps the
// model toward the state, plays the anim the server picked, flashes white
// when hit, and reports deaths (hp reset + teleport) so the scene can
// spawn a pooled particle burst + floating damage number.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from '../config.js';
import { frameDamp } from '../anim/AnimUtils.js';

export default class Enemy {
  constructor(scene, state, model, anims, scale = 1) {
    this.scene = scene;
    this.state = state; // live EnemyState ref, patched by colyseus

    this.root = new THREE.Group();
    this.root.scale.setScalar(scale);
    // SkeletonUtils.clone: skinned GLB — see Player.js for why.
    const mesh = skeletonClone(model);
    this.materials = [];
    mesh.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      this.materials.push(o.material);
    });
    this.root.add(mesh);
    scene.add(this.root);

    this.mixer = new THREE.AnimationMixer(mesh);
    this.clips = {};
    for (const [name, clipName] of Object.entries(CONFIG.anims.enemy)) {
      const clip = THREE.AnimationClip.findByName(anims, clipName);
      if (clip) this.clips[name] = this.mixer.clipAction(clip);
    }
    this.playAnim('idle');
    this.root.position.set(state.x, 0, state.z);
    this.root.rotation.y = state.rotY;

    // Combat-feedback bookkeeping (Upgrade C).
    this.lastHp = state.hp;
    this.flashT = 0;         // seconds of white flash left
    this.onBurst = null;     // scene hook: (worldPos) -> particle burst
    this.onDamage = null;    // scene hook: (worldPos) -> floating number
  }

  playAnim(name) {
    const action = this.clips[name];
    if (!action || action === this.current) return;
    this.current = action;
    this.mixer.stopAllAction();
    action.reset().play();
  }

  update(dt) {
    const s = this.state;
    const prevX = this.root.position.x;
    const prevZ = this.root.position.z;
    // RC4: frameDamp replaces the fixed `* 0.2` (60fps-only) lerp factor.
    const t = frameDamp(0.2, dt);
    this.root.position.x += (s.x - this.root.position.x) * t;
    this.root.position.z += (s.z - this.root.position.z) * t;
    let dy = s.rotY - this.root.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.root.rotation.y += dy * t;

    // Hit feedback: hp dropped -> white flash + floating damage number.
    if (s.hp < this.lastHp) {
      this.flashT = 0.18;
      const at = { x: this.root.position.x, y: 2, z: this.root.position.z };
      this.onDamage?.(at, '1');
    }
    // Death: hp reset to full + teleport = the enemy was killed and
    // respawned. Burst at the OLD spot before the teleport lerp drags it.
    if (s.hp > this.lastHp || Math.hypot(s.x - prevX, s.z - prevZ) > 6) {
      this.onBurst?.({ x: prevX, y: 1.2, z: prevZ }, 0xff6b6b);
      this.scene.sound?.hit?.(); // thud for the kill
    }
    this.lastHp = s.hp;

    this.flashT = Math.max(0, this.flashT - dt);
    const flash = this.flashT > 0;
    for (const m of this.materials) {
      m.emissive?.setHex(flash ? 0xffffff : 0x000000);
    }

    this.playAnim(s.anim); // idle/run/attack/hit from the server
    this.mixer.update(dt);
  }

  dispose() {
    this.root.parent?.remove(this.root);
  }
}
