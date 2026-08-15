// Local player controller. Reads keyboard input, runs the Idle/Run FSM,
// and sends input intents to the server — the server owns the position.
// This object is the client-side render view of the server state: the
// model lerps toward the latest server x/z/rotY like every other player,
// and power-up effects (shield bubble, double tint) render from state.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { attachSword } from './Sword.js';
import StateMachine from '../fsm/StateMachine.js';
import IdleState from '../fsm/states/IdleState.js';
import RunState from '../fsm/states/RunState.js';
import { CONFIG } from '../config.js';
import { sendInput } from '../network.js';

export default class Player {
  /**
   * @param {THREE.Scene} scene  the game scene (render world)
   * @param {Room} room          the colyseus room (for sending input)
   * @param {THREE.Group} model  cloned GLB scene shared by all players
   * @param {THREE.AnimationClip[]} anims  animation clips from the GLB
   * @param {number} color       server-assigned tint (PlayerState.color)
   * @param {number} scale       model scale (Quaternius models vary in size)
   */
  constructor(scene, room, model, anims, color, scale = 1) {
    this.scene = scene;
    this.room = room;
    this.state = null; // live PlayerState ref, set by the scene on join
    this.baseColor = new THREE.Color(color);

    // Clone of the shared GLB, materials cloned so the tint is per-player.
    // SkeletonUtils.clone: the GLBs are skinned — Object3D.clone would keep
    // the skeleton bound to the SOURCE hierarchy's bones (which never get
    // updated), collapsing the character into nothing.
    this.root = new THREE.Group();
    this.root.scale.setScalar(scale);
    this.mesh = skeletonClone(model);
    this.materials = [];
    this.mesh.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.material.color.copy(this.baseColor);
      o.castShadow = true;
      this.materials.push(o.material);
    });
    this.root.add(this.mesh);
    // Everyone carries a sword: the melee attack is a sword slash and the
    // GLB ships without a weapon.
    this.sword = attachSword(this.mesh);
    scene.add(this.root);

    // SHIELD power-up bubble: translucent sphere, hidden until the effect.
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

    // Animation clips, keyed by our logical names (see CONFIG.anims).
    this.mixer = new THREE.AnimationMixer(this.mesh);
    this.clips = {};
    for (const [name, clipName] of Object.entries(CONFIG.anims.player)) {
      const clip = THREE.AnimationClip.findByName(anims, clipName);
      if (clip) this.clips[name] = this.mixer.clipAction(clip);
    }

    // Keys: state objects updated by GameScene's window listeners.
    this.keys = scene.keys;

    // FSM wiring — identical API to termgame.
    this.fsm = new StateMachine('Idle');
    this.fsm.addState('Idle', new IdleState());
    this.fsm.addState('Run', new RunState());
    this.animName = 'idle';
    this.moving = false;
    this.fsm.start(this);

    // Swing: attackAnimMs of attack anim, attackCooldownMs until J works
    // again (server enforces the same numbers).
    this.attackAnimT = 0;
    this.attackCd = 0;
    this.sendTimer = 0;      // input throttle
    this.lastSent = { dirX: 0, dirZ: 0, attack: false, anim: 'idle' };
  }

  /** Play a logical anim by name (idle/run/attack), reusing the clip. */
  playAnim(name) {
    const action = this.clips[name];
    if (!action || action === this.current) return;
    this.current = action;
    this.mixer.stopAllAction();
    action.reset().play();
  }

  /** Render the timed power-up effects straight from PlayerState.effects. */
  updateEffects(effects) {
    const hasShield = effects?.has?.('shield') ?? false;
    this.shieldMesh.visible = hasShield;
    // DOUBLE tints the model gold; otherwise back to the server color.
    const hasDouble = effects?.has?.('double') ?? false;
    const tint = hasDouble ? new THREE.Color(CONFIG.effects.double.color) : this.baseColor;
    for (const m of this.materials) m.color.copy(tint);
  }

  /** Called every frame with the fixed dt and the camera (unused: input is
   *  character-relative, see below). */
  update(dt, _camera) {
    const k = this.keys;

    // --- Input: CHARACTER-relative ---------------------------------------
    // W runs along the current facing, A/D strafe-turn. NOT camera-relative:
    // the camera rig follows the server yaw, which the server derives from
    // the movement direction — a camera-relative dir feeds back through
    // server rotY -> camera orbit -> changed input, steering the player in
    // unwanted arcs.
    const ix = (k.d.isDown || k.right.isDown ? 1 : 0) - (k.a.isDown || k.left.isDown ? 1 : 0);
    const iz = (k.w.isDown || k.up.isDown ? 1 : 0) - (k.s.isDown || k.down.isDown ? 1 : 0);
    this.moving = ix !== 0 || iz !== 0;

    // Facing/right from the RENDER yaw (matches the server's atan2(dirX,dirZ)
    // convention, so holding W keeps rotY stable and the run stays straight).
    const yaw = this.root.rotation.y;
    const fx = Math.sin(yaw), fz = Math.cos(yaw); // forward
    const rx = -fz, rz = fx;                      // screen-right
    this.dirX = fx * iz + rx * ix;
    this.dirZ = fz * iz + rz * ix;

    // --- Swing + FSM ----------------------------------------------------
    this.attackAnimT = Math.max(0, this.attackAnimT - dt);
    this.attackCd = Math.max(0, this.attackCd - dt);
    const attack = k.j.justPressed && this.attackCd <= 0;
    k.j.justPressed = false;          // consume the edge
    if (attack) {
      this.attackCd = CONFIG.player.attackCooldownMs / 1000;
      this.attackAnimT = CONFIG.player.attackAnimMs / 1000;
      this.scene.sound.swing();       // combat feedback
    }
    this.fsm.update(this, dt);
    if (this.attackAnimT > 0) this.animName = 'attack'; // swing overrides run/idle

    // --- Send intent (throttled to ~30Hz, only when something changed) --
    this.sendTimer -= dt;
    if (this.sendTimer <= 0) {
      const msg = { dirX: this.dirX, dirZ: this.dirZ, attack, anim: this.animName };
      const l = this.lastSent;
      if (msg.dirX !== l.dirX || msg.dirZ !== l.dirZ || msg.attack !== l.attack || msg.anim !== l.anim) {
        sendInput(this.room, msg.dirX, msg.dirZ, msg.attack, msg.anim);
        this.lastSent = msg;
        this.sendTimer = 1 / 30;
      }
    }

    // --- Render: smooth toward server state + animation ------------------
    // Frame-rate independent exponential smoothing (1 - e^(-k dt)); big
    // jumps (respawn teleports) snap instead of sliding across the arena.
    const s = this.state;
    if (s) {
      const jump = Math.hypot(s.x - this.root.position.x, s.z - this.root.position.z);
      const t = jump > 4 ? 1 : 1 - Math.exp(-(this.moving ? 20 : 10) * dt);
      this.root.position.x += (s.x - this.root.position.x) * t;
      this.root.position.z += (s.z - this.root.position.z) * t;
      let dy = s.rotY - this.root.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.root.rotation.y += dy * (1 - Math.exp(-18 * dt));
      this.updateEffects(s.effects);
    }
    this.playAnim(this.animName);
    this.mixer.update(dt);
  }

  dispose() {
    this.root.parent?.remove(this.root);
  }
}
