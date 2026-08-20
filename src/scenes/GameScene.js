// GameScene: builds the whole 3D world (renderer, lights, ground, props),
// owns the camera rig + HUD + overlays, and maps server state onto
// entities. Nothing here simulates gameplay — the server is authoritative;
// this scene renders matchState/countdown, renders power-up effects,
// shows nametags + leaderboard, plays feedback (shake, flash, particles,
// floating numbers) and handles reconnects.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CONFIG, setServerUrl } from '../config.js';
import Player from '../entities/Player.js';
import RemotePlayer from '../entities/RemotePlayer.js';
import Enemy from '../entities/Enemy.js';
import SoundManager from '../audio/SoundManager.js';
import ParticlePool from '../effects/ParticlePool.js';
import FloatingTextPool from '../effects/FloatingTextPool.js';
import SkillFx from '../effects/SkillFx.js';
import { resolveChainTargets, BASH_RANGE } from '../shared/skills.js';
import { joinGame, reconnectRoom, sendRespawn, sendPlayAgain, sendNextWave, sendChooseUpgrade, joinErrorMessage, serverAvailable } from '../network.js';
import { LocalRoom } from '../LocalRoom.js';
import { getUpgrade } from '../shared/progression.js';
import { stripRootMotion, frameDamp, cameraOffset, subclipAnims } from '../anim/AnimUtils.js';
import TouchControls from '../ui/TouchControls.js';

// Deterministic LCG: scatters props identically on every client so the
// arena looks the same for all players, without a network round trip.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export default class GameScene {
  constructor(container) {
    // --- Renderer (quality knobs from config, Upgrade F) -----------------
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.renderer.dprMax));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = CONFIG.renderer.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // Window resize: keep the canvas + camera aspect in sync (previously the
    // canvas was sized once and resizing distorted the view).
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb); // sky
    this.camera = new THREE.PerspectiveCamera(
      60, window.innerWidth / window.innerHeight, 0.1, 200);

    // --- Lights ---------------------------------------------------------
    const hemi = new THREE.HemisphereLight(0xffffff, 0x446622, 0.75);
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(20, 30, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(CONFIG.renderer.shadowMapSize, CONFIG.renderer.shadowMapSize);
    sun.shadow.camera.left = -35;
    sun.shadow.camera.right = 35;
    sun.shadow.camera.top = 35;
    sun.shadow.camera.bottom = -35;
    sun.shadow.camera.far = 80;
    this.scene.add(hemi, sun);

    // --- FX: pooled particles + floating numbers (Upgrade C/F) ----------
    this.sound = new SoundManager();
    this.particles = new ParticlePool(this.scene, 256);
    this.floatTexts = new FloatingTextPool(document.getElementById('float-layer'), 24);
    this.skillFx = new SkillFx(this.scene); // Phase 3 cast visuals (slash/ring/arcs)

    // --- World state holders --------------------------------------------
    this.keys = {};
    this.buildKeyboard();
    this.touchControls = new TouchControls(this);
    this.buildGround();
    this.props = [];

    this.local = null;             // Player (ours)
    this.remotePlayers = new Map();// sessionId -> RemotePlayer
    this.enemies = new Map();      // enemy index -> Enemy
    this.orbViews = [];            // { mesh, state } pairs
    this.powerUpViews = [];        // { mesh, state } pairs
    this.nametags = new Map();     // sessionId -> { div, state }
    this.projectiles = new Map(); // projectile id -> { mesh, light? }
    this.wired = false;
    this.cameraRigged = false;     // camera snapped to the player yet?
    this.models = null;
    this.name = '';

    // Feedback timers.
    this.shakeT = 0;               // camera-shake seconds left
    this.flashT = 0;               // red-flash seconds left
    this.lastHp = 100;
    this.lastScore = 0;
    this.lastEffects = new Map();  // effect name -> ms, for pickup detection
    this.lastCountdown = -1;
    this.lastMatchState = '';
    this.deadShown = false;

    // HUD handles (index.html).
    this.hudFill = document.getElementById('hp-fill');
    this.hudText = document.getElementById('hud-text');
    this.cooldownFill = document.getElementById('cooldown-fill');
    this.skillCooldownFill = document.getElementById('skill-cooldown-fill');
    this.countdownEl = document.getElementById('countdown');
    this.flashEl = document.getElementById('flash');
    this.leaderboardEl = document.getElementById('leaderboard');
    this.overlay = document.getElementById('gameover');
    this.overlayTitle = document.getElementById('gameover-title');
    this.overlaySub = document.getElementById('gameover-sub');
    this.reconnectEl = document.getElementById('reconnect');
    this.loginEl = document.getElementById('login');
    this.loginName = document.getElementById('login-name');
    this.loginServer = document.getElementById('login-server');
    this.loginError = document.getElementById('login-error');
    this.loginBtn = document.getElementById('login-btn');
    this.netBadge = document.getElementById('net-badge');
    // Phase 4: upgrade card overlay
    this.upgradeOverlay = document.getElementById('upgrade-overlay');
    this.upgradeGrid = document.getElementById('upgrade-grid');
    this.upgradeTimer = document.getElementById('upgrade-timer');
    this.upgradeTitle = document.getElementById('upgrade-title');
    this._pendingChoicesStr = '';
    this._upgradeDeadline = 0;

    // One overlay serves three ends: death (respawn), wave cleared (next
    // wave) and match end (again). Priority in that order on click.
    this.overlay.addEventListener('click', () => {
      if (!this.room) return;
      const ms = this.room.state.matchState;
      if (ms === 'gameover') {
        this.overlay.classList.remove('visible');
        sendPlayAgain(this.room);
      } else if (ms === 'intermission') {
        // Wave-cleared popup: the click asks the room for the next wave —
        // in multiplayer the FIRST click advances the room for everyone.
        this.overlay.classList.remove('visible');
        sendNextWave(this.room);
      } else if (this.local?.state?.hp <= 0) {
        this.overlay.classList.remove('visible');
        this.deadShown = false;
        sendRespawn(this.room);
      }
    });
  }

  /**
   * Entities (Player/RemotePlayer/Enemy) receive this wrapper as their
   * "scene" — they need .keys/.sound — so delegate object insertion to the
   * underlying THREE.Scene for them.
   */
  add(object) {
    this.scene.add(object);
  }

  // ============================ Boot =====================================

  async init() {
    // Remember the last name; the form is always shown before connecting.
    this.name = localStorage.getItem('opengame.name') ?? '';
    this.loginName.value = this.name;
    // Character choice persists like the name; the server clamps the index.
    const saved = Number(localStorage.getItem('opengame.character'));
    this.character = Number.isFinite(saved)
      ? Math.max(0, Math.min(CONFIG.characters.length - 1, saved)) : 0;
    this.buildCharacterPicker();
    // Server field: prefilled with the last used ?server=/typed value — the
    // host's quick-tunnel URL changes every session, so friends paste the
    // fresh one here. Empty = the default chain (env.js/same-origin).
    this.loginServer.value = localStorage.getItem('opengame.server') || '';
    // Probe the default server while the player is still typing a name, so
    // the join click never waits on it: online -> real room, offline (e.g.
    // GitHub Pages with the host's tunnel down) -> browser-local solo.
    this.probedUrl = CONFIG.serverUrl;
    this.serverOnline = serverAvailable();
    this.loginEl.classList.add('visible');
    this.loginBtn.addEventListener('click', () => this.onJoinClick());
    this.loginName.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.onJoinClick(); });
    this.loginServer.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.onJoinClick(); });
  }

  /** Character cards on the login screen (CONFIG.characters drives it). */
  buildCharacterPicker() {
    const picker = document.getElementById('char-picker');
    picker.innerHTML = '';
    CONFIG.characters.forEach((c, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'char-card' + (i === this.character ? ' selected' : '');
      btn.textContent = c.label;
      btn.addEventListener('click', () => {
        this.character = i;
        localStorage.setItem('opengame.character', String(i));
        for (const el of picker.children) el.classList.remove('selected');
        btn.classList.add('selected');
      });
      picker.appendChild(btn);
    });
  }

  async onJoinClick() {
    if (this.joining) return;
    this.joining = true;
    this.name = this.loginName.value.trim().slice(0, 16) || 'player';
    localStorage.setItem('opengame.name', this.name);
    // First user gesture: unlock audio (browser requirement) + start pad.
    this.sound.init();
    try {
      if (!this.models) {
        this.models = await this.loadModels();
        this.scatterProps();
      }
      document.getElementById('loading').style.display = 'none';
      this.loginEl.classList.remove('visible');
      this.loginError.style.display = 'none';
      // A typed server wins over every default. If it points somewhere the
      // early probe didn't check (fresh tunnel URL), probe that host now.
      const rawServer = this.loginServer.value.trim();
      if (rawServer && setServerUrl(rawServer) && CONFIG.serverUrl !== this.probedUrl) {
        this.probedUrl = CONFIG.serverUrl;
        this.serverOnline = serverAvailable();
      }
      const online = await this.serverOnline;
      if (online) {
        this.room = await joinGame(this.name, this.character);
      } else {
        // No server (static hosting, host offline): same wire-up, but the
        // room is a browser-local simulation — single-player only.
        this.room = new LocalRoom();
        await this.room.join(this.name, this.character);
      }
      this.setNetBadge(online);
      this.wireRoom();
      this.touchControls?.show();
    } catch (err) {
      console.error(err);
      this.loginError.textContent = joinErrorMessage(err);
      this.loginError.style.display = 'block';
    }
    this.joining = false;
  }

  /** Show/hide the OFFLINE badge (top-center) so players know they are in
   *  the local simulation rather than a hosted multiplayer room. */
  setNetBadge(online) {
    if (this.netBadge) this.netBadge.style.display = online ? 'none' : 'block';
  }

  loadModels() {
    const loader = new GLTFLoader();
    const load = (url) => new Promise((res, rej) => loader.load(url, res, undefined, rej));
    // Timeout guard: an unreachable CDN / dead link must not leave the
    // client stuck on "loading…" forever (see onJoinClick error surface).
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timed out loading models — network too slow or unreachable')), CONFIG.loadTimeoutMs));
    return Promise.race([
      Promise.all([
        ...CONFIG.characters.map((c) => load(`assets/characters/${c.file}`)), // roster
        load('assets/props/sword.glb'),   // swordsman weapon prop
        load('assets/enemies/orc.glb'),   // enemy model
        load('assets/props/tree.glb'),    // arena props
        load('assets/props/rock.glb')
      ]),
      timeout
    ]).then((all) => {
      // Promise.all resolves FLAT: [char0..charN, sword, enemy, tree, rock].
      const [sword, enemy, tree, rock] = all.slice(CONFIG.characters.length);
      const characters = {};
        // RC1: strip baked root motion (Mixamo hips translation) from every
        // clip at load time — the server owns x/z, animated hips must not
        // drag the mesh away from its lerped position. Clean rigs (archer/
        // mage/demon) pass through untouched.
        CONFIG.characters.forEach((c, i) => {
          const animations = stripRootMotion(all[i].animations);
          // Swordsman: trim the attack static hold AND the draw gesture
          // embedded in the Idle clip (see config.js subclip comments).
          characters[c.key] = { scene: all[i].scene, animations: subclipAnims(animations, c) };
        });
      return {
        characters,
        sword: sword.scene,
        enemy: enemy.scene, enemyAnims: stripRootMotion(enemy.animations),
        tree: tree.scene, rock: rock.scene
      };
    });
  }

  // ====================== Room / state wiring =============================

  /**
   * Wire room callbacks. Re-entrant: on reconnect (Upgrade F) the old
   * entities are disposed and fresh ones are created from the new room's
   * full state — no page reload.
   */
  wireRoom() {
    this.disposeEntities();
    this.wired = false;
    // Read-only introspection handle for the Playwright e2e flow (assert
    // match/wave state, drive the popup) — exposes nothing the page doesn't
    // already hold.
    window.__OPENGAME_DEBUG__ = { room: this.room };
    this.room.onStateChange((state) => {
      if (!this.wired) { this.wired = true; this.wireState(state); }
    });

    // BLOCKED feedback: the server tells the victim whenever a hit was negated
    // by their guard (enemy contact, another player's melee or skill) — clang +
    // "BLOCKED" text + a spark burst where the guard held.
    this.room.onMessage('blocked', (d) => {
      this.sound.blocked();
      const x = d?.x ?? this.local?.root.position.x ?? 0;
      const z = d?.z ?? this.local?.root.position.z ?? 0;
      this.floatTexts.spawn(x, 2.6, z, 'BLOCKED', '#7ec8ff');
      this.particles.spawnBurst({ x, y: 1.2, z }, CONFIG.effects.block.color, 14, 3, 0.45);
    });

    // Phase 4: leveling toasts + upgrade results
    this.room.onMessage('levelUp', (d) => {
      this.sound.powerUp();
      const lvl = d?.level ?? '?';
      this.floatTexts.spawn(this.local?.root.position.x ?? 0, 2.8, this.local?.root.position.z ?? 0, `LEVEL ${lvl}!`, '#ffd54f');
    });
    this.room.onMessage('upgradeResult', (d) => {
      const name = getUpgrade(d?.picked)?.name ?? d?.picked ?? '';
      const suffix = d?.auto ? ' (auto)' : '';
      if (name) this.floatTexts.spawn(this.local?.root.position.x ?? 0, 2.6, this.local?.root.position.z ?? 0, name + suffix, '#a5d6a7');
    });

    // Upgrade F: the sdk reconnects dropped sockets automatically (colyseus
    // reconnection API). We just surface it to the player and keep a manual
    // fallback for the cases the sdk gives up on.
    this.room.onDrop(() => this.reconnectEl.classList.add('visible'));
    this.room.onReconnect(() => {
      this.reconnectEl.classList.remove('visible');
      console.log('[client] auto-reconnected — state resynced');
    });
    // CONSENTED (4000) = deliberate leave; anything else means the sdk's
    // automatic reconnection is not possible (room too young / retries
    // exhausted) -> manual retry loop.
    this.room.onLeave((code) => {
      if (code !== 4000) this.handleDisconnect();
    });
  }

  handleDisconnect() {
    console.warn('[client] connection lost — reconnecting');
    this.reconnectEl.classList.add('visible');
    this.reconnectAttempts = 0;
    this.tryReconnect();
  }

  async tryReconnect() {
    this.reconnectAttempts = (this.reconnectAttempts ?? 0) + 1;
    // Exponential backoff (1.5s -> 3s -> 6s -> capped 10s): a flapping
    // connection must not hammer the server — and the fresh-join fallback
    // below consumes per-IP rate-limit tokens, so a tight loop would lock
    // this address out of joining entirely.
    const backoff = Math.min(1500 * 2 ** (this.reconnectAttempts - 1), 10000);
    try {
      // Preferred path: resume the same seat (position/score survive).
      const room = await reconnectRoom(this.room, this.name);
      this.room = room;
      this.reconnectEl.classList.remove('visible');
      this.wireRoom();
      console.log('[client] reconnected with seat');
      return;
    } catch (err) {
      // Token invalid (room disposed / too young): after a few attempts,
      // fall back to a fresh join so the player is never stuck.
      if (this.reconnectAttempts > 3) {
        try {
          this.room = await joinGame(this.name, this.character);
          this.reconnectEl.classList.remove('visible');
          this.wireRoom();
          console.log('[client] re-joined fresh');
          return;
        } catch (joinErr) {
          const jm = (joinErr && joinErr.message) || '';
          if (jm.includes('too many join attempts')) {
            // Rate-limited: wait well past the bucket refill (~1 token/2s)
            // instead of retrying into the lockout.
            this.reconnectEl.querySelector('.sub').textContent =
              'too many join attempts — retrying in a few seconds…';
          }
        }
      }
      setTimeout(() => this.tryReconnect(), backoff);
    }
  }

  wireState(state) {
    // Schema onAdd callbacks only fire for *future* changes, so entities
    // for the initial state are created here, before the listeners.
    for (const [sid, player] of state.players) this.addPlayer(sid, player);
    for (let i = 0; i < state.enemies.length; i++) this.addEnemy(i, state.enemies[i]);
    for (let i = 0; i < state.orbs.length; i++) this.addOrb(i, state.orbs[i]);
    for (let i = 0; i < state.powerUps.length; i++) this.addPowerUp(i, state.powerUps[i]);

    // Schema v4 removed the instance-method callbacks (state.players.onAdd
    // no longer exists). The SDK bundles its own @colyseus/schema decoder,
    // so callbacks MUST be registered through it — Colyseus.Callbacks
    // (from the UMD global, same one network.js uses) reaches the room's
    // real decoder. immediate=false keeps v3 semantics: the loops above
    // already created the initial entities.
    // A LocalRoom has no decoder (it mutates the state objects in place);
    // its entities are fixed slots created by the loops above, so the
    // incremental add/remove callbacks are unnecessary — and
    // getLegacy() would throw on the missing serializer.
    if (!this.room.serializer) return;
    const $ = Colyseus.Callbacks.getLegacy(this.room);
    $(state.players).onAdd((player, sid) => this.addPlayer(sid, player), false);
    $(state.players).onRemove((_player, sid) => {
      const rp = this.remotePlayers.get(sid);
      if (rp) { rp.dispose(); this.remotePlayers.delete(sid); }
      const tag = this.nametags.get(sid);
      if (tag) { tag.div.remove(); this.nametags.delete(sid); }
    });

    $(state.enemies).onAdd((enemy, i) => this.addEnemy(i, enemy), false);
    $(state.enemies).onRemove((_enemy, i) => {
      const e = this.enemies.get(i);
      if (e) { e.dispose(); this.enemies.delete(i); }
    });

    $(state.orbs).onAdd((orb, i) => this.addOrb(i, orb), false);
    $(state.powerUps).onAdd((pu, i) => this.addPowerUp(i, pu), false);

    $(state.projectiles).onAdd((proj) => this.addProjectile(proj.id, proj), false);
    $(state.projectiles).onRemove((proj) => {
      const v = this.projectiles.get(proj.id);
      if (v) { this.scene.remove(v.mesh); this.projectiles.delete(proj.id); }
    });
  }

  /** Remove every entity + nametag (called before re-wiring on reconnect). */
  disposeEntities() {
    this.local?.dispose();
    this.local = null;
    for (const rp of this.remotePlayers.values()) rp.dispose();
    this.remotePlayers.clear();
    for (const e of this.enemies.values()) e.dispose();
    this.enemies.clear();
    for (const v of this.orbViews) this.scene.remove(v.mesh);
    this.orbViews = [];
    for (const v of this.powerUpViews) this.scene.remove(v.mesh);
    this.powerUpViews = [];
    for (const v of this.projectiles.values()) this.scene.remove(v.mesh);
    this.projectiles.clear();
    for (const tag of this.nametags.values()) tag.div.remove();
    this.nametags.clear();
  }

  /** Create the local or a remote player entity for a sessionId. */
  addPlayer(sid, player) {
    const color = player.color || CONFIG.colors.orb;
    // The server clamps the index; defend against stale/patched clients too.
    const def = CONFIG.characters[player.character] ?? CONFIG.characters[0];
    const pack = this.models.characters[def.key];
    if (sid === this.room.sessionId) {
      // Our own player: the camera follows this one.
      this.local = new Player(this, this.room, pack, def, color, this.models.sword);
      this.local.state = player;
      // Skill cast VFX, per kind (Phase 3): bash = slash + landing ring +
      // burst; chainlight = arcs through the targets (same shared chain math
      // the server used, so the arcs land on what actually got hit);
      // multishot / firewave = muzzle burst (the projectiles themselves
      // render through the projectile pool).
      this.local.onSkill = (pos, sdef, rotY) => {
        this.particles.spawnBurst({ x: pos.x, y: 1.0, z: pos.z }, sdef.color, 30, 6, 0.7);
        if (sdef.kind === 'bash') {
          this.skillFx.slash(pos, rotY, sdef.color, 1.4);
          this.skillFx.ring({
            x: pos.x + Math.sin(rotY) * BASH_RANGE,
            z: pos.z + Math.cos(rotY) * BASH_RANGE
          }, sdef.color, 3);
        } else if (sdef.kind === 'chainlight') {
          this._chainArcsFrom(pos, sdef);
        }
      };
      this.local.root.position.set(player.x, 0, player.z); // snap to spawn
      this.cameraRigged = false;
      this.lastHp = player.hp;
      this.lastScore = player.score;
    } else {
      this.remotePlayers.set(sid, new RemotePlayer(this, player, pack, def, color, this.models.sword));
    }
    this.nametagFor(sid, player, color);
  }

  /** Create an enemy entity. Orcs are bigger than the adventurer. */
  addEnemy(i, enemy) {
    const e = new Enemy(this, enemy, this.models.enemy, this.models.enemyAnims, 0.55);
    e.onBurst = (pos, color) => this.particles.spawnBurst(pos, color, 26, 5.5, 0.8);
    e.onHitSpark = (pos) => {
      this.particles.spawnBurst(pos, 0xffffff, 10, 3, 0.35);  // spark
      this.particles.spawnBurst(pos, 0xcc0000, 8, 4, 0.5);    // blood
    };
    e.onDamage = (pos, amount) => this.floatTexts.spawn(pos.x, pos.y, pos.z, amount, '#ffd54f');
    this.enemies.set(i, e);
  }

  /** Create an orb mesh (positions are read from state every frame). */
  addOrb(i, orb) {
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.45, 1),
      new THREE.MeshStandardMaterial({ color: CONFIG.colors.orb, emissive: 0x22aa22, emissiveIntensity: 0.6 })
    );
    mesh.position.set(orb.x, CONFIG.orb.y, orb.z);
    this.scene.add(mesh);
    this.orbViews[i] = { mesh, state: orb };
  }

  /** Create a power-up orb (pooled slot; pulsing + glow, per Upgrade B). */
  addPowerUp(i, pu) {
    const type = pu.type || 'speed';
    const color = CONFIG.powerUps.colors[type] ?? 0xffffff;
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.5, 1),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8 })
    );
    mesh.position.set(pu.x, CONFIG.powerUps.y, pu.z);
    this.scene.add(mesh);
    this.powerUpViews[i] = { mesh, state: pu, color };
  }

  /**
   * Chain-lightning VFX: run the SAME shared chain-target selection the
   * server just ran (resolveChainTargets over the live enemy list) and draw
   * jagged arcs hopping caster -> each target in chain order.
   */
  _chainArcsFrom(casterPos, sdef) {
    const enemies = [...(this.room?.state?.enemies ?? [])]
      .filter((e) => e.hp > 0)
      .map((e) => ({ x: e.x, z: e.z }));
    const chain = resolveChainTargets(
      { x: casterPos.x, z: casterPos.z }, enemies, sdef.damage, sdef.maxTargets);
    if (!chain.length) return;
    const points = [{ x: casterPos.x, z: casterPos.z }];
    for (const c of chain) points.push(enemies[c.idx]);
    this.skillFx.chain(points, sdef.color);
  }

  /** Create a projectile mesh (arrow cylinder, fireball sphere+light, lightning box). */
  addProjectile(id, proj) {
    const cfg = CONFIG.projectiles[proj.kind] ?? CONFIG.projectiles.arrow;
    let mesh;
    if (proj.kind === 'arrow') {
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(cfg.scale, cfg.scale * 0.5, cfg.height, 6),
        new THREE.MeshStandardMaterial({ color: cfg.color, emissive: cfg.emissive, emissiveIntensity: 0.6 })
      );
      mesh.rotation.x = Math.PI / 2; // point forward along Z
    } else if (proj.kind === 'fireball') {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(cfg.scale, 8, 6),
        new THREE.MeshStandardMaterial({ color: cfg.color, emissive: cfg.emissive, emissiveIntensity: 1 })
      );
      const light = new THREE.PointLight(cfg.lightColor, cfg.lightIntensity, 4);
      mesh.add(light);
    } else {
      // lightning: thin box
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(cfg.scale, cfg.scale, cfg.height),
        new THREE.MeshStandardMaterial({ color: cfg.color, emissive: cfg.emissive, emissiveIntensity: 0.8 })
      );
    }
    mesh.position.set(proj.x, 0.8, proj.z);
    // Orient mesh to face the direction of travel
    mesh.rotation.y = Math.atan2(proj.dirX, proj.dirZ);
    this.scene.add(mesh);
    this.projectiles.set(id, { mesh });
  }

  // ============================ World =====================================

  /** Procedural grass ground: canvas texture, drawn once and reused. */
  buildGround() {
    const rng = makeRng(1337);
    const size = 512;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3f7d46';
    ctx.fillRect(0, 0, size, size);
    // darker grid + speckles so motion is readable
    ctx.strokeStyle = 'rgba(20,60,25,0.35)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 8; i++) {
      ctx.beginPath(); ctx.moveTo(i * size / 8, 0); ctx.lineTo(i * size / 8, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * size / 8); ctx.lineTo(size, i * size / 8); ctx.stroke();
    }
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(30,80,35,0.5)' : 'rgba(120,180,90,0.4)';
      ctx.fillRect(rng() * size, rng() * size, 3, 3);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 6);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(CONFIG.world.size, CONFIG.world.size),
      new THREE.MeshStandardMaterial({ map: tex })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Arena walls: faint translucent boxes so the bounds are visible.
    const h = CONFIG.world.size / 2;
    const wallMat = new THREE.MeshBasicMaterial({ color: 0x224466, transparent: true, opacity: 0.25, side: THREE.DoubleSide });
    const mk = (w, d, x, z) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 3, d), wallMat);
      wall.position.set(x, 1.5, z);
      this.scene.add(wall);
    };
    mk(CONFIG.world.size, 0.5, 0, h);  mk(CONFIG.world.size, 0.5, 0, -h);
    mk(0.5, CONFIG.world.size, h, 0);  mk(0.5, CONFIG.world.size, -h, 0);
  }

  /** Scatter trees/rocks outside the central spawn zone, deterministically. */
  scatterProps() {
    const rng = makeRng(4242);
    const h = CONFIG.world.size / 2 - 1;
    const place = (model, scale) => {
      for (let tries = 0; tries < 8; tries++) {
        const x = -h + rng() * h * 2;
        const z = -h + rng() * h * 2;
        if (Math.abs(x) < 7 && Math.abs(z) < 7) continue;
        const prop = model.clone(true);
        prop.traverse((o) => { if (o.isMesh) o.castShadow = true; });
        prop.scale.setScalar(scale);
        prop.position.set(x, 0, z);
        prop.rotation.y = rng() * Math.PI * 2;
        this.scene.add(prop);
        this.props.push(prop);
        return;
      }
    };
    // Scales tuned from the GLB world AABBs (tree 7.6 tall, rock 0.2).
    for (let i = 0; i < 9; i++) place(this.models.tree, 0.8 + rng() * 0.5);
    for (let i = 0; i < 10; i++) place(this.models.rock, 3.5 + rng() * 2.5);
  }

  /** Keyboard state shared with Player: { isDown, justPressed } per key. */
  buildKeyboard() {
    const map = {
      KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      KeyJ: 'j', KeyK: 'k', KeyL: 'l', KeyM: 'm'
    };
    for (const name of Object.values(map)) {
      this.keys[name] = { isDown: false, justPressed: false };
    }
    window.addEventListener('keydown', (e) => {
      const k = this.keys[map[e.code]];
      if (!k) return;
      if (!k.isDown) k.justPressed = true;
      k.isDown = true;
      e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      const k = this.keys[map[e.code]];
      if (k) k.isDown = false;
    });
  }

  // ============================ Frame =====================================

  /** One render frame. dt is the clamped delta from main.js. */
  update(dt, _time) {
    // M = mute toggle (Upgrade D).
    if (this.keys.m.justPressed) {
      this.keys.m.justPressed = false;
      this.sound.toggleMute();
    }

    if (this.local) {
      this.local.update(dt, this.camera);

      // --- Camera rig: lerp behind the player, look at them -------------
      const target = this.local.root.position;
      const cfg = CONFIG.player.camera;
      // RC5: FIXED azimuth — the rig follows the player's position only and
      // never reads the character's yaw, so it cannot orbit. Player.update
      // maps WASD onto the same cfg.yaw, so W always runs directly away from
      // the camera and A/D strafe in straight lines (no "round and round").
      const off = cameraOffset(cfg.yaw, cfg.distance);
      const desired = new THREE.Vector3(
        target.x + off.x,
        target.y + cfg.height,
        target.z + off.z
      );
      if (!this.cameraRigged) {
        this.camera.position.copy(desired); // snap on spawn, then lerp
        this.cameraRigged = true;
      }
      // RC4: rate-correct the 60fps-tuned lerp factor so the rig converges
      // identically at any frame rate (30/144Hz screens included).
      this.camera.position.lerp(desired, frameDamp(cfg.lerp, dt));

      // Damage camera shake: small random offset, decaying over 0.3s.
      if (this.shakeT > 0) {
        this.shakeT = Math.max(0, this.shakeT - dt);
        const amp = this.shakeT / CONFIG.player.shake.duration * CONFIG.player.shake.amplitude;
        this.camera.position.x += (Math.random() - 0.5) * amp;
        this.camera.position.y += (Math.random() - 0.5) * amp;
      }
      this.camera.lookAt(target);

      this.updateMatchUi(dt);
    }
    for (const rp of this.remotePlayers.values()) {
      rp.update(dt);
      // Phase 3 remote cast visuals: fire the knight slash / bash ring on the
      // anim EDGE (idle|run -> attack|skill), same feedback the local caster
      // sees on their own character.
      const a = rp.state.anim;
      if (a !== rp.lastFxAnim) {
        rp.lastFxAnim = a;
        const p = rp.root.position;
        if (a === 'attack' && rp.def.key === 'swordsman') {
          this.skillFx.slash(p, rp.root.rotation.y, 0xffffff, 1);
        } else if (a === 'skill' && rp.skillDef.kind === 'bash') {
          this.skillFx.slash(p, rp.root.rotation.y, rp.skillDef.color, 1.4);
          this.skillFx.ring({ x: p.x + Math.sin(rp.root.rotation.y) * BASH_RANGE, z: p.z + Math.cos(rp.root.rotation.y) * BASH_RANGE }, rp.skillDef.color, 3);
        } else if (a === 'skill' && rp.skillDef.kind === 'chainlight') {
          this._chainArcsFrom(p, rp.skillDef);
        }
      }
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const e of this.enemies.values()) e.update(dt, this.camera, w, h);
    for (const view of this.orbViews) {
      view.mesh.position.x = view.state.x;
      view.mesh.position.z = view.state.z;
      // Slow spin + bob sells the "collectible" look (purely cosmetic).
      view.mesh.rotation.y += dt * 2;
      view.mesh.position.y = CONFIG.orb.y + Math.sin(performance.now() / 400) * 0.15;
    }

    // Power-ups: pulsing scale while active; hidden while respawning.
    const now = performance.now();
    for (const view of this.powerUpViews) {
      view.mesh.visible = view.state.active;
      if (!view.state.active) continue;
      view.mesh.position.x = view.state.x;
      view.mesh.position.z = view.state.z;
      const pulse = 1 + Math.sin(now / 180) * 0.18;
      view.mesh.scale.setScalar(pulse);
      view.mesh.position.y = CONFIG.powerUps.y + Math.sin(now / 350) * 0.15;
      view.mesh.rotation.y += dt * 1.5;
    }

    // Projectiles: create missing views (LocalRoom has no serializer so
    // onAdd never fires — the update loop must be the view factory there),
    // sync positions, then remove views for spliced-out projectiles.
    const liveIds = new Set();
    for (const proj of this.room?.state?.projectiles ?? []) {
      liveIds.add(proj.id);
      let v = this.projectiles.get(proj.id);
      if (!v) {
        this.addProjectile(proj.id, proj);
        v = this.projectiles.get(proj.id);
      }
      if (v) {
        v.mesh.position.x = proj.x;
        v.mesh.position.z = proj.z;
        v.mesh.rotation.y = Math.atan2(proj.dirX, proj.dirZ);
      }
    }
    // Remove client views for projectiles the server already spliced out.
    for (const [id, v] of this.projectiles) {
      if (!liveIds.has(id)) {
        this.scene.remove(v.mesh);
        this.projectiles.delete(id);
      }
    }

    // Speed power-up trail: emit particles behind any runner with it.
    if (this.local?.state?.effects?.has('speed')) {
      const p = this.local.root.position;
      this.particles.spawnBurst(
        { x: p.x - Math.sin(this.local.root.rotation.y) * 0.6, y: 0.6, z: p.z - Math.cos(this.local.root.rotation.y) * 0.6 },
        CONFIG.effects.speed.color, 2, 1.2, 0.4);
    }

    this.touchControls?.update();
    this.particles.update(dt);
    this.skillFx.update(dt);
    this.floatTexts.update(dt, this.camera, window.innerWidth, window.innerHeight);
    this.updateNametags();
    this.updateLeaderboard();

    this.renderer.render(this.scene, this.camera);
  }

  /** Countdown, game-over overlay, red flash, HUD + cooldown bar. */
  updateMatchUi(dt) {
    const state = this.room.state;
    const me = this.room.state.players.get(this.room.sessionId);
    if (!me) return;

    // --- Match lifecycle UI (server-driven, Upgrade A) ------------------
    if (state.matchState !== this.lastMatchState) {
      this.lastMatchState = state.matchState;
      if (state.matchState === 'countdown') {
        this.sound.tick();
        // A countdown that follows the wave popup (or a respawn overlay)
        // must clear it — the room moved on.
        this.overlay.classList.remove('visible');
        this.deadShown = false;
      }
      if (state.matchState === 'playing') { this.sound.go(); this.countdownEl.textContent = ''; }
      if (state.matchState === 'intermission') {
        // WAVE CLEARED popup: blocks the game until a player clicks (the
        // click sends 'nextWave' — see the overlay click handler). While it
        // is up every player is invulnerable (damagePlayer gates on
        // 'playing'), and movement stays free.
        this.sound.waveClear();
        this.overlayTitle.textContent = `WAVE ${state.wave} CLEARED!`;
        this.overlaySub.textContent =
          `click anywhere to start wave ${state.wave + 1} — everyone is invulnerable until then`;
        this.overlay.classList.add('visible');
        this.deadShown = true; // suppress the death overlay underneath
      }
      if (state.matchState === 'gameover') {
        this.sound.gameOver();
        this.overlayTitle.textContent = state.winnerId === this.room.sessionId
          ? 'YOU WIN!' : state.winnerName + ' WINS!';
        const scores = [...state.players.values()]
          .sort((a, b) => b.score - a.score).slice(0, 3)
          .map((p) => `${p.name}: ${p.score}`).join('   ');
        this.overlaySub.textContent = scores + '   — PLAY AGAIN →';
        this.overlay.classList.add('visible');
        this.deadShown = true; // match end supersedes the death overlay
      }
    }
    if (state.matchState === 'countdown') {
      const c = Math.ceil(state.countdown);
      // Wave banner above the big number ("WAVE 3" / 3-2-1) — a smaller
      // label line, then the countdown digit on its own line.
      this.countdownEl.innerHTML =
        `<div style="font-size:26px;letter-spacing:8px;">WAVE ${state.wave}</div>` +
        (c > 0 ? String(c) : '');
      if (c !== this.lastCountdown && c > 0) { this.lastCountdown = c; this.sound.tick(); }
    } else {
      this.lastCountdown = -1;
    }

    // --- Death overlay (respawn) vs. match-over overlay -----------------
    if (me.hp <= 0 && state.matchState === 'playing' && !this.deadShown) {
      this.deadShown = true;
      this.overlayTitle.textContent = 'YOU DIED';
      this.overlaySub.textContent = 'click to respawn';
      this.overlay.classList.add('visible');
    }
    if (me.hp > 0 && this.deadShown && state.matchState !== 'gameover') {
      this.deadShown = false;
      this.overlay.classList.remove('visible');
    }

    // --- HUD: hp bar, score, players, cooldown bar -----------------------
    const pct = Math.max(0, me.hp) / CONFIG.player.maxHp * 100;
    this.hudFill.style.width = pct + '%';
    this.hudFill.style.background = pct > 50 ? '#4caf50' : pct > 25 ? '#ff9800' : '#f44336';
    this.hudText.textContent =
      `wave ${state.wave}   score ${me.score}   players ${state.players.size}   target ${CONFIG.match.targetScore}` +
      (state.matchState === 'intermission' ? '   ★ INVULNERABLE — wave cleared' : '') +
      (me.blocking ? '   🛡 BLOCKING' : '') +
      (this.touchControls?.active
        ? '   joystick move · ⚔ attack · ✨ skill · 🛡 block'
        : '   WASD move · J attack · K skill · L block (hold) · M mute');
    // Cooldown bar: drains while J is on cooldown (server mirrors it).
    const cdMs = Math.max(me.attackCd, this.local.attackCd * 1000);
    this.cooldownFill.style.width = Math.min(100, cdMs / CONFIG.player.attackCooldownMs * 100) + '%';
    // Skill cooldown bar (K): drains over the class's skill cooldown.
    const scdMs = Math.max(me.skillCd, this.local.skillCd * 1000);
    this.skillCooldownFill.style.width = Math.min(100, scdMs / this.local.skillDef.cooldownMs * 100) + '%';

    // --- Damage feedback: red flash + shake + sound + number + blood ------
    if (me.hp < this.lastHp) {
      const dmg = this.lastHp - me.hp;
      this.flashT = 0.3;
      this.shakeT = CONFIG.player.shake.duration;
      this.sound.hit();
      this.floatTexts.spawn(me.x, 2.4, me.z, String(dmg), '#ff5252');
      this.particles.spawnBurst({ x: me.x, y: 1.0, z: me.z }, 0xcc0000, 6, 3, 0.4);
    }
    this.lastHp = me.hp;
    this.flashT = Math.max(0, this.flashT - dt);
    this.flashEl.style.opacity = this.flashT > 0 ? (this.flashT / 0.3) * 0.35 : '0';

    // --- Pickup detection for sounds -------------------------------------
    if (me.score > this.lastScore) this.sound.pickup();
    this.lastScore = me.score;
    for (const [name, ms] of me.effects) {
      if (!this.lastEffects.has(name)) {
        this.sound.powerUp();
        this.floatTexts.spawn(me.x, 2.6, me.z, name.toUpperCase(), '#ffffff');
      }
      this.lastEffects.set(name, ms);
    }
    for (const name of [...this.lastEffects.keys()]) {
      if (!me.effects.has(name)) this.lastEffects.delete(name);
    }

    // --- Level-up upgrade cards (Phase 4) --------------------------------
    const pending = [...(me.pendingChoices ?? [])];
    const pendingStr = pending.join('|');
    if (pending.length > 0) {
      if (pendingStr !== this._pendingChoicesStr) {
        this._pendingChoicesStr = pendingStr;
        this._upgradeDeadline = performance.now() + 10000;
        this.upgradeTitle.textContent = `LEVEL ${me.level} — Choose an upgrade`;
        this.upgradeGrid.innerHTML = '';
        pending.forEach((id, idx) => {
          const def = getUpgrade(id) ?? { name: id, desc: '' };
          const card = document.createElement('div');
          card.className = 'up-card';
          card.innerHTML = `<div class="up-title">${idx + 1}. ${def.name}</div><div class="up-desc">${def.desc}</div>`;
          card.addEventListener('click', () => {
            sendChooseUpgrade(this.room, id);
            this.upgradeOverlay.classList.remove('visible');
          });
          this.upgradeGrid.appendChild(card);
        });
        if (this._upgradeKeyHandler) window.removeEventListener('keydown', this._upgradeKeyHandler);
        this._upgradeKeyHandler = (e) => {
          if (e.key >= '1' && e.key <= '3') {
            const i = Number(e.key) - 1;
            if (pending[i]) sendChooseUpgrade(this.room, pending[i]);
          }
        };
        window.addEventListener('keydown', this._upgradeKeyHandler);
      }
      const remain = Math.max(0, Math.ceil((this._upgradeDeadline - performance.now()) / 1000));
      this.upgradeTimer.textContent = `auto-picks ${getUpgrade(pending[0])?.name ?? pending[0]} in ${remain}s — press 1/2/3 or click`;
      this.upgradeOverlay.classList.add('visible');
    } else if (this._pendingChoicesStr !== '') {
      this._pendingChoicesStr = '';
      this._upgradeDeadline = 0;
      this.upgradeOverlay.classList.remove('visible');
      if (this._upgradeKeyHandler) { window.removeEventListener('keydown', this._upgradeKeyHandler); this._upgradeKeyHandler = null; }
    }

    // HUD: show level + XP alongside score
    this.hudText.textContent =
      `Lv ${me.level} (${me.xp} XP)  wave ${state.wave}  score ${me.score}  players ${state.players.size}  target ${CONFIG.match.targetScore}` +
      (state.matchState === 'intermission' ? '  ★ INVULNERABLE — wave cleared' : '') +
      (me.blocking ? '  🛡 BLOCKING' : '') +
      (pending.length ? '  ★ CHOOSE UPGRADE!' : '') +
      (this.touchControls?.active
        ? '  joystick move · ⚔ attack · ✨ skill · 🛡 block'
        : '  WASD move · J attack · K skill · L block (hold) · M mute · 1/2/3 pick upgrade');
  }

  /** Billboarded nametags (name + HP) projected above each player. */
  updateNametags() {
    if (!this.room) return; // before joining
    const w = window.innerWidth;
    const h = window.innerHeight;
    const v = new THREE.Vector3();
    for (const [sid, tag] of this.nametags) {
      const root = sid === this.room.sessionId ? this.local?.root : this.remotePlayers.get(sid)?.root;
      if (!root) continue;
      v.set(root.position.x, root.position.y + 2.6, root.position.z);
      v.project(this.camera);
      const behind = v.z > 1;
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      tag.div.style.display = behind ? 'none' : 'block';
      if (behind) continue;
      tag.div.style.transform = `translate(-50%, -100%) translate(${sx}px, ${sy}px)`;
      tag.div.textContent = `${tag.state.name} ${tag.state.hp}`;
      tag.div.style.borderColor = tag.color;
    }
  }

  nametagFor(sid, player, color) {
    const existing = this.nametags.get(sid);
    if (existing) return existing;
    const div = document.createElement('div');
    div.className = 'nametag';
    div.style.borderColor = '#' + new THREE.Color(color).getHexString();
    document.getElementById('nametag-layer').appendChild(div);
    const tag = { div, state: player, color: '#' + new THREE.Color(color).getHexString() };
    this.nametags.set(sid, tag);
    return tag;
  }

  /** Top 5 + you, sorted by score, refreshed at ~4Hz. */
  updateLeaderboard() {
    const state = this.room?.state;
    if (!state?.players?.size) return;
    if (performance.now() - (this.boardAt ?? 0) < 250) return;
    this.boardAt = performance.now();
    const me = this.room.sessionId;
    const rows = [...state.players.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((p) => {
        const you = p === state.players.get(me) ? ' ▶' : '';
        return `<span>${esc(p.name)}${you} <b>${p.score}</b></span>`;
      })
      .join('');
    this.leaderboardEl.innerHTML = 'LEADERBOARD<br>' + rows;
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
