// Enemy view: renders the server-side enemy state. All logic (chase,
// damage, stun, death, waves) happens in the room — this class only lerps the
// model toward the state, plays the anim the room picked, flashes white when
// hit, staggers while the room holds the HIT-STUN anim, plays a quick shrink
// on death (killed enemies STAY DEAD until the next wave revives their slot)
// and snaps back in when a new wave spawns. Health bar (HTML overlay) tracks
// HP above the head, scaled to the wave's max HP.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from '../config.js';
import { attackTimeScale, frameDamp } from '../anim/AnimUtils.js';
import { SERVER } from '../server/config.js';

// Death: quick scale-down before the corpse disappears (purely cosmetic —
// the room already considers the enemy dead at hp 0).
const DEATH_SHRINK_S = 0.28;

export default class Enemy {
  constructor(scene, state, model, anims, scale = 1) {
    this.scene = scene;
    this.state = state; // live EnemyState ref, patched by colyseus
    this.baseScale = scale;

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
    this.onBurst = null;     // scene hook: (worldPos) -> particle burst (death)
    this.onHitSpark = null;  // scene hook: (worldPos) -> small spark burst (hit)
    this.onDamage = null;    // scene hook: (worldPos, amount) -> floating number

    // Wave lifecycle: hp <= 0 = dead slot (hidden); the room revives slots
    // at wave start. maxHp scales with the wave (see shared/waves.js).
    this.dead = state.hp <= 0;
    this.maxHp = state.hp > 0 ? state.hp : SERVER.enemy.hp;
    this.deathT = 0;         // seconds of shrink anim left
    if (this.dead) this.root.visible = false;

    // Health bar (HTML overlay, follows the enemy's head). Created once per
    // enemy and updated every frame to track HP and position.
    this.hpBar = {
      div: document.createElement('div'),
      maxHp: this.maxHp
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
    if (name === 'hit') {
      // Squeeze the whole hit-react into the HIT-STUN window so the react
      // completes before the enemy resumes acting (same trick as the swing).
      action.setLoop(THREE.LoopOnce);
      action.clampWhenFinished = true;
      action.timeScale = attackTimeScale(action.getClip(), SERVER.enemy.hitStunMs);
    } else if (name === 'attack') {
      action.setLoop(THREE.LoopOnce);
      action.clampWhenFinished = true;
      action.timeScale = attackTimeScale(action.getClip(), SERVER.enemy.attackAnimMs);
    } else {
      action.timeScale = 1;
      action.setLoop(THREE.LoopRepeat);
    }
  }

  update(dt, camera, width, height) {
    const s = this.state;

    // --- Wave lifecycle transitions --------------------------------------
    if (s.hp <= 0 && !this.dead) {
      // Died this patch: burst where it stood + shrink out.
      this.dead = true;
      this.deathT = DEATH_SHRINK_S;
      this.onBurst?.({ x: this.root.position.x, y: 1.2, z: this.root.position.z }, 0xff6b6b);
      this.scene.sound?.death?.();
    } else if (s.hp > 0 && this.dead) {
      // Slot revived by a new wave: snap in at the spawn point — never
      // glide across the arena from the old corpse position.
      this.dead = false;
      this.maxHp = s.hp;
      this.hpBar.maxHp = this.maxHp;
      this.root.visible = true;
      this.root.scale.setScalar(this.baseScale);
      this.root.position.set(s.x, 0, s.z);
      this.root.rotation.y = s.rotY;
      this.current = null; // force the idle action to restart below
      this.playAnim('idle');
      this.lastHp = s.hp;
    }

    if (this.dead) {
      // Corpse: finish the shrink, then hide everything.
      if (this.deathT > 0) {
        this.deathT = Math.max(0, this.deathT - dt);
        this.root.scale.setScalar(this.baseScale * (this.deathT / DEATH_SHRINK_S));
        if (this.deathT === 0) this.root.visible = false;
      }
      this.hpBar.div.style.display = 'none';
      this.lastHp = s.hp;
      return;
    }

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

    // Hit feedback: hp dropped -> white flash + spark + floating damage
    // number with the ACTUAL amount (skills hit for more than the melee).
    if (s.hp < this.lastHp) {
      this.flashT = 0.18;
      const at = { x: this.root.position.x, y: 2, z: this.root.position.z };
      this.onDamage?.(at, String(Math.max(1, Math.round(this.lastHp - s.hp))));
      this.onHitSpark?.(at);
      this.scene.sound?.enemyHit?.();
    }
    this.lastHp = s.hp;

    this.flashT = Math.max(0, this.flashT - dt);
    const flash = this.flashT > 0;
    for (const m of this.materials) {
      m.emissive?.setHex(flash ? 0xffffff : 0x000000);
    }

    this.playAnim(s.anim); // idle/run/attack/hit from the room
    this.mixer.update(dt);

    // --- Health bar: track above the enemy's head, show HP percentage ---
    if (this.hpBar && this.hpBar.div) {
      const pct = Math.max(0, s.hp) / this.maxHp;
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
