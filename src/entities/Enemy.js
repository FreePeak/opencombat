// Enemy view: renders the server-side enemy state. All logic (chase,
// damage, death, respawn) happens in GameRoom — this class only lerps the
// model toward the state, plays the anim the server picked, flashes white
// when hit, and reports deaths (hp reset + teleport) so the scene can
// spawn a pooled particle burst + floating damage number. Health bar (HTML
// overlay) tracks HP above the head.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from '../config.js';
import { frameDamp } from '../anim/AnimUtils.js';
import { SERVER } from '../server/config.js';

const MAX_HP = SERVER.enemy.hp; // enemies always respawn at this max

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

    // Health bar (HTML overlay, follows the enemy's head). Created once per
    // enemy and updated every frame to track HP and position.
    this.hpBar = {
      div: document.createElement('div'),
      maxHp: MAX_HP
    };
    this.hpBar.div.className = 'enemy-hp-bar';
    this.hpBar.div.style.cssText = `
      position: absolute; top: 0; left: 0; pointer-events: none;
      width: 32px; height: 4px; background: #333; border: 1px solid #555;
      transform: translate(-50%, -100%); display: none;
    `;
    this.hpBar.fill = document.createElement('div');
    this.hpBar.fill.style.cssText = `
      height: 100%; background: #4caf50; transition: width 0.1s, background 0.2s;
    `;
    this.hpBar.div.appendChild(this.hpBar.fill);
    // Add to the nametag layer (same layer as player nametags).
    document.getElementById('nametag-layer')?.appendChild(this.hpBar.div);
    this.v = new THREE.Vector3(); // reusable projection vector
  }

  playAnim(name) {
    const action = this.clips[name];
    if (!action || action === this.current) return;
    this.current = action;
    this.mixer.stopAllAction();
    action.reset().play();
  }

  update(dt, camera, width, height) {
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

    // --- Health bar: track above the enemy's head, show HP percentage ---
    if (this.hpBar && this.hpBar.div) {
      const pct = Math.max(0, s.hp) / this.hpBar.maxHp;
      this.hpBar.fill.style.width = (pct * 100) + '%';
      // Color shifts from green (full) to red (empty).
      const r = Math.min(255, Math.floor((1 - pct) * 2 * 255));
      const g = Math.min(255, Math.floor(pct * 2 * 255));
      this.hpBar.fill.style.background = `rgb(${r},${g},0)`;
      this.hpBar.div.style.display = 'block';

      // Project to screen space (same technique as FloatingTextPool).
      const v = this.v;
      v.set(this.root.position.x, 2.8, this.root.position.z); // above head
      v.project(camera);
      const cx = (v.x * 0.5 + 0.5) * width;
      const cy = (-v.y * 0.5 + 0.5) * height;
      // Hide if behind camera or off-screen.
      if (v.z > 1 || cx < 0 || cx > width || cy < 0 || cy > height) {
        this.hpBar.div.style.display = 'none';
      } else {
        this.hpBar.div.style.transform = `translate(-50%, -100%) translate(${cx}px, ${cy}px)`;
      }
    }
  }

  dispose() {
    this.root.parent?.remove(this.root);
    this.hpBar.div?.remove();
  }
}
