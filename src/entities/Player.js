// Local player controller. Reads keyboard input, runs the Idle/Run FSM,
// and sends input intents to the server — the server owns the position.
// This object is the client-side render view of the server state: the
// model lerps toward the latest server x/z/rotY like every other player,
// and power-up effects (shield bubble, double tint) render from state.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { attachWeapon, ProceduralAnim } from './Sword.js';
import StateMachine from '../fsm/StateMachine.js';
import IdleState from '../fsm/states/IdleState.js';
import RunState from '../fsm/states/RunState.js';
import { CONFIG } from '../config.js';
import { sendInput } from '../network.js';
import { attackTimeScale, shouldSendInput, cameraMoveDir, frameDamp, MOVING_ATTACK_RUN_BLEND, ACTION_BLEND, SPAWN_DRAW_S } from '../anim/AnimUtils.js';
import { skillFor } from '../shared/skills.js';

export default class Player {
  /**
   * @param {THREE.Scene} scene  the game scene (render world)
   * @param {Room} room          the colyseus room (for sending input)
   * @param {THREE.Group} model  { scene, animations } GLB pack for this class
   * @param {object} def         character def from CONFIG.characters
   * @param {number} color       server-assigned tint (PlayerState.color)
   * @param {THREE.Group|null} swordModel  loaded sword GLB (swordsman weapon)
   */
  constructor(scene, room, model, def, color, swordModel = null) {
    this.scene = scene;
    this.room = room;
    this.state = null; // live PlayerState ref, set by the scene on join
    this.def = def;
    this.baseColor = new THREE.Color(color);

    // Clone of the shared GLB, materials cloned so the tint is per-player.
    // SkeletonUtils.clone: the GLBs are skinned — Object3D.clone would keep
    // the skeleton bound to the SOURCE hierarchy's bones (which never get
    // updated), collapsing the character into nothing.
    this.root = new THREE.Group();
    this.root.scale.setScalar(def.scale);
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
    // Per-class weapon: sword GLB / procedural bow / none (built-in).
    this.weapon = attachWeapon(this.mesh, def, swordModel);
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

    // BLOCK guard: a translucent shield wall floating in front of the player
    // while L is held (local prediction; the server broadcasts `blocking` for
    // remotes). Local +Z is the facing direction (rotY = atan2 convention).
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
    this.blocking = false;    // L held this frame (predicted locally)

    // Animation clips, keyed by our logical names (see CONFIG.characters).
    // Models that ship no clips (the knight) get ProceduralAnim instead.
    // RC10: every action is started ONCE here and blending is done purely
    // with eased weights (see updateClipAnims) — no stopAllAction pops.
    this.mixer = new THREE.AnimationMixer(this.mesh);
    this.clips = {};
    for (const [name, clipName] of Object.entries(def.anims)) {
      if (!clipName) continue;
      const clip = THREE.AnimationClip.findByName(model.animations, clipName);
      if (clip) this.clips[name] = this.mixer.clipAction(clip);
    }
    this.currentName = 'idle';
    this.wAtk = 0;
    this.wRun = 0;
    this.wIdle = this.clips.idle ? 1 : 0;
    for (const action of Object.values(this.clips)) {
      action.setEffectiveWeight(0);
      action.play();
    }
    // Attack clip plays once then clamps to its final frame. LoopOnce at
    // construction is what makes the SPAWN DRAW a one-shot: the clip plays
    // through a single time at full weight (see drawT below) and can never
    // loop a phantom draw under idle.
    if (this.clips.attack) {
      this.clips.attack.setLoop(THREE.LoopOnce);
      this.clips.attack.clampWhenFinished = true;
    }
    if (this.clips.idle) this.clips.idle.setEffectiveWeight(1);
    // Draw-sword happens ONCE, on spawn: while drawT counts down the attack
    // clip blends at full weight (a single ready/draw gesture); afterwards
    // idle and run play clean with no residual attack pose.
    this.drawT = this.clips.attack ? SPAWN_DRAW_S : 0;
    this.proc = Object.keys(this.clips).length ? null : new ProceduralAnim(this.root, this.weapon);

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
    this.pendingAttack = false; // RC3: attack edge latched until it is sent
    this.lastSent = { dirX: 0, dirZ: 0, attack: false, skill: false, anim: 'idle', block: false };

    // Per-character skill (K): every class shares the J melee but casts its
    // own skill. The server enforces the same cooldown/damage (src/shared).
    this.charIndex = Math.max(0, CONFIG.characters.indexOf(def));
    this.skillDef = skillFor(this.charIndex);
    this.skillAnimT = 0;
    this.skillCd = 0;
    this.pendingSkill = false;
    this.onSkill = null;    // GameScene sets this to spawn the cast VFX
  }

  /**
   * RC10 clip driver: all three actions run permanently; what changes per
   * frame is their WEIGHT, eased toward the current target (see
   * ACTION_BLEND). This gives real crossfades — the swing blends in over
   * ~100ms instead of snapping on, blends back out into idle/run at the
   * end, and the run-under-swing blend (RC8) fades rather than popping
   * when movement starts/stops mid-swing.
   */
  updateClipAnims(_dt) {
    const casting = this.skillAnimT > 0;
    const swinging = casting || this.attackAnimT > 0;
    const drawing = this.drawT > 0;
    const atk = this.clips.attack;
    const run = this.clips.run;
    const idle = this.clips.idle;

    // Target weights for this frame.
    let tAtk = 0, tRun = 0, tIdle = 0;
    if (swinging && atk) {
      tAtk = 1;
      if (this.moving && run) tRun = MOVING_ATTACK_RUN_BLEND;
      const name = casting ? 'skill' : 'attack';
      if (this.currentName !== name) {
        this.currentName = name;
        atk.reset();
        atk.setLoop(THREE.LoopOnce);
        atk.clampWhenFinished = true;
        atk.timeScale = attackTimeScale(atk.getClip(),
          casting ? this.skillDef.animMs : CONFIG.player.attackAnimMs);
        atk.play();
      }
    } else if (drawing && atk) {
      // One-time spawn draw: full-weight single playthrough of the clip
      // (LoopOnce + clamp were set at construction), legs still stepping if
      // the player is already moving.
      tAtk = 1;
      if (this.moving && run) tRun = MOVING_ATTACK_RUN_BLEND;
      this.currentName = 'draw';
    } else if (this.moving && run) {
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

    // --- Input: CAMERA-relative against a FIXED azimuth (RC5) -------------
    // WASD maps onto the fixed camera basis, NOT the character's own yaw. The
    // camera rig no longer orbits with the character (GameScene uses the same
    // fixed azimuth), so there is no turn->move->turn feedback loop: holding A
    // or D strafes along a constant world direction (a straight line) instead
    // of steering the player — and the camera — round and round in a circle.
    // L (hold) = block: guarding roots the player (no movement input) and the
    // swing/cast cannot be started while blocking.
    this.blocking = !!k.l?.isDown;
    this.guardMesh.visible = this.blocking;
    const ix = this.blocking ? 0 :
      (k.d.isDown || k.right.isDown ? 1 : 0) - (k.a.isDown || k.left.isDown ? 1 : 0);
    const iz = this.blocking ? 0 :
      (k.w.isDown || k.up.isDown ? 1 : 0) - (k.s.isDown || k.down.isDown ? 1 : 0);
    // Touch joystick overrides digital WASD axes (analog, partial deflection = slower).
    const stick = this.blocking ? null : this.scene.touchStick;
    const fi = stick ? stick.x : ix;
    const fz = stick ? stick.z : iz;
    this.moving = fi !== 0 || fz !== 0;
    const dir = cameraMoveDir(fi, fz, CONFIG.player.camera.yaw);
    this.dirX = dir.x;
    this.dirZ = dir.z;

    // --- Swing + skill + FSM --------------------------------------------
    this.attackAnimT = Math.max(0, this.attackAnimT - dt);
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.skillAnimT = Math.max(0, this.skillAnimT - dt);
    this.skillCd = Math.max(0, this.skillCd - dt);
    this.drawT = Math.max(0, this.drawT - dt);
    // COMBAT RULE (mirrored by the server): an attack CANNOT be started while
    // blocking — the J/K press is consumed with a hint instead. Attacks ARE
    // allowed while moving.
    const attackReady = k.j.justPressed && this.attackCd <= 0;
    const attack = attackReady && !this.blocking;
    if (k.j.justPressed && attackReady && !attack) {
      this.scene.floatTexts?.spawn(this.root.position.x, 2.4, this.root.position.z,
        'LOWER GUARD TO ATTACK', '#ffd54f');
    }
    k.j.justPressed = false;          // consume the edge
    if (attack) {
      this.attackCd = CONFIG.player.attackCooldownMs / 1000;
      this.attackAnimT = CONFIG.player.attackAnimMs / 1000;
      this.scene.sound.swing();       // combat feedback
    }
    // K casts the per-character skill; the server applies the class's
    // damage/cooldown authoritatively. Casts work while moving.
    const skillReady = k.k.justPressed && this.skillCd <= 0;
    const skill = skillReady && !this.blocking;
    if (k.k.justPressed && skillReady && !skill && !attack) {
      this.scene.floatTexts?.spawn(this.root.position.x, 2.4, this.root.position.z,
        'LOWER GUARD TO CAST', '#4fc3f7');
    }
    k.k.justPressed = false;          // consume the edge
    if (skill) {
      this.skillCd = this.skillDef.cooldownMs / 1000;
      this.skillAnimT = this.skillDef.animMs / 1000;
      this.scene.sound.swing();
      this.onSkill?.(this.root.position, this.skillDef); // cast VFX hook
    }
    this.fsm.update(this, dt);
    // A cast overrides a swing, which overrides run/idle.
    if (this.skillAnimT > 0) this.animName = 'skill';
    else if (this.attackAnimT > 0) this.animName = 'attack';

    // --- Send intent (throttled to ~30Hz, only when something changed) --
    // RC3: the attack edge lives for a single frame; latch it so the send
    // throttle can never diff it away. A pending edge flushes immediately
    // (which also cuts swing latency by up to a whole throttle slot).
    if (attack) this.pendingAttack = true;
    if (skill) this.pendingSkill = true;
    this.sendTimer -= dt;
    if (this.pendingAttack || this.pendingSkill || this.sendTimer <= 0) {
      const msg = { dirX: this.dirX, dirZ: this.dirZ, attack: this.pendingAttack, skill: this.pendingSkill, anim: this.animName, block: this.blocking };
      if (shouldSendInput(this.lastSent, msg)) {
        sendInput(this.room, msg.dirX, msg.dirZ, msg.attack, msg.skill, msg.anim, msg.block);
        this.lastSent = msg;
      }
      this.pendingAttack = false;
      this.pendingSkill = false;
      this.sendTimer = 1 / 30;
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
    if (this.proc) this.proc.update(dt, this.moving, this.attackAnimT > 0 || this.skillAnimT > 0);
    else {
      this.updateClipAnims(dt);
      this.mixer.update(dt);
    }
  }

  dispose() {
    this.root.parent?.remove(this.root);
  }
}
