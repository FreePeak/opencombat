// GameScene: builds the whole 3D world (renderer, lights, ground, props),
// owns the camera rig + HUD + overlays, and maps server state onto
// entities. Nothing here simulates gameplay — the server is authoritative;
// this scene renders matchState/countdown, renders power-up effects,
// shows nametags + leaderboard, plays feedback (shake, flash, particles,
// floating numbers) and handles reconnects.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CONFIG, setServerUrl } from '../config.js';
import { recordRun, tierForCareer } from '../shared/sim/careerStats.js';
import { loadLocalCareer, saveLocalCareer } from '../shared/sim/localCareer.js';

// Career unlock tiers (PRD-career-stats.md): cosmetic nametag accents.
const TIER_COLORS = { 1: '#7c4dff', 2: '#ffd700', 3: '#ff5252' };
import Player from '../entities/Player.js';
import RemotePlayer from '../entities/RemotePlayer.js';
import Enemy from '../entities/Enemy.js';
import SoundManager from '../audio/SoundManager.js';
import MusicDirector from '../audio/MusicDirector.js';
import ParticlePool from '../effects/ParticlePool.js';
import FloatingTextPool from '../effects/FloatingTextPool.js';
import SkillFx from '../effects/SkillFx.js';
import { resolveChainTargets, BASH_RANGE } from '../shared/skills.js';
import { MILESTONES } from '../shared/sim/streaks.js';
import { waveEnemyHp } from '../shared/waves.js';
import { achievementById, evaluateAchievements } from '../shared/sim/achievements.js';
import { SERVER } from '../server/config.js';
import { joinGame, reconnectRoom, sendRespawn, sendPlayAgain, sendNextWave, sendChooseUpgrade, sendChooseShop, joinErrorMessage, serverAvailable,
  joinWorld, joinLobby, sendQueue, consumeReservation, spectateMatch, fetchJoinTicket } from '../network.js';
import { LocalRoom } from '../LocalRoom.js';
import { getUpgrade } from '../shared/progression.js';
import { stripRootMotion, frameDamp, cameraOffset, subclipAnims } from '../anim/AnimUtils.js';
import TouchControls from '../ui/TouchControls.js';
import { ChunkManager } from '../client/ChunkManager.js';
import { Minimap } from '../ui/Minimap.js';
import { CombatRadar } from '../ui/CombatRadar.js';
import { buildShareCard, shareText } from '../shared/sim/shareCard.js';
import { objectiveProgress } from '../shared/sim/objectivesHud.js';
import { makeTuftGeometry, makeFlowerGeometry, makeBushGeometry, makeOrbGeometry, makeSpeedGeometry, makeShieldGeometry, makeDoubleGroup } from '../client/Grass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/** Login-screen game modes. `offline` = can fall back to the browser-local
 *  solo simulation when no server is reachable (PvP needs opponents and the
 *  open world needs the hosted chunked room — neither exists offline).
 *  Daily and Weekly degrade to local waves too (no streak/best recorded). */
const MODES = [
  { key: 'waves', label: 'Waves', offline: true },
  { key: 'pvp', label: 'PvP Arena', offline: false },
  { key: 'world', label: 'Open World', offline: false },
  { key: 'daily', label: 'Daily', offline: true },
  { key: 'weekly', label: 'Weekly', offline: true }
];

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
      if (this.composer) this.composer.setSize(window.innerWidth, window.innerHeight);
    });

    this.scene = new THREE.Scene();
    const atm = CONFIG.atmosphere;
    this.scene.background = new THREE.Color(atm.sky); // sky
    // Fog matched to the sky: the arena edge / streamed chunks fade instead
    // of clipping against the far plane (ARTWORK_PLAN phase 2).
    this.scene.fog = new THREE.Fog(atm.sky, atm.fogNear, atm.fogFar);
    this.camera = new THREE.PerspectiveCamera(
      60, window.innerWidth / window.innerHeight, 0.1, 200);

    // --- Lights ---------------------------------------------------------
    const hemi = new THREE.HemisphereLight(0xffffff, 0x446622, atm.hemiIntensity);
    const sun = new THREE.DirectionalLight(atm.sunColor, atm.sunIntensity);
    sun.position.set(20, 30, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(CONFIG.renderer.shadowMapSize, CONFIG.renderer.shadowMapSize);
    sun.shadow.camera.left = -35;
    sun.shadow.camera.right = 35;
    sun.shadow.camera.top = 35;
    sun.shadow.camera.bottom = -35;
    sun.shadow.camera.far = 80;
    this.scene.add(hemi, sun);

    // --- Bloom: EffectComposer + UnrealBloomPass (ARTWORK_PLAN phase 6, gated) ---
    // Default OFF until perf-verified (60fps at dpr 2). When ENABLE_BLOOM=1 the
    // server injects bloom:true via /env.js -> CONFIG.renderer.bloom; the
    // composer path is used instead of the direct renderer render.
    this.composer = null;
    this.bloomPass = null;
    if (CONFIG.renderer.bloom) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        CONFIG.renderer.bloomStrength,
        CONFIG.renderer.bloomRadius,
        CONFIG.renderer.bloomThreshold
      );
      this.composer.addPass(this.bloomPass);
    }

    // --- FX: pooled particles + floating numbers (Upgrade C/F) ----------
    this.sound = new SoundManager();
    this.particles = new ParticlePool(this.scene, 256);
    this.floatTexts = new FloatingTextPool(document.getElementById('float-layer'), 24);
    this.skillFx = new SkillFx(this.scene); // Phase 3 cast visuals (slash/ring/arcs)

    // --- World state holders --------------------------------------------
    this.keys = {};
    this.buildKeyboard();
    this.touchControls = new TouchControls(this);
    this.arenaGroup = new THREE.Group(); // bounded-arena visuals (removed in world mode)
    this.scene.add(this.arenaGroup);
    this.buildGround();
    this.props = [];

    // Login-screen mode: 'waves' (default) | 'pvp' | 'world' | 'daily' |
    // 'weekly' — see MODES.
    this.mode = 'waves';
    this.worldMode = false;       // open-world visuals active (chunks + minimap)
    this.chunkManager = null;
    this.minimap = null;
    this.combatRadar = null;      // match-mode HUD radar (PRD-combat-radar.md)

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
    // Combat juice (PRD-kill-streaks.md layer 2, render-only).
    this.trauma = 0;               // trauma-shake accumulator 0..1
    this.hitStopUntil = 0;         // FX freeze deadline (performance.now ms)
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
    // OIDC SSO (PRD-oidc-login.md): feature-gated sign-in link + VERIFIED
    // pill on the login card — both hidden until /api/me reports feature-on.
    this.ssoLoginEl = document.getElementById('sso-login');
    this.ssoLoginEl?.addEventListener('click', () => this.startSsoLogin());
    this.verifiedBadgeEl = document.getElementById('verified-badge');
    this.netBadge = document.getElementById('net-badge');
    // Phase 4: upgrade card overlay
    this.upgradeOverlay = document.getElementById('upgrade-overlay');
    this.upgradeGrid = document.getElementById('upgrade-grid');
    this.upgradeTimer = document.getElementById('upgrade-timer');
    this.upgradeTitle = document.getElementById('upgrade-title');
    this._pendingChoicesStr = '';
    this._upgradeDeadline = 0;
    // Intermission shop overlay
    this.shopOverlay = document.getElementById('shop-overlay');
    this.shopGrid = document.getElementById('shop-grid');
    this.shopTimer = document.getElementById('shop-timer');
    this.shopTitle = document.getElementById('shop-title');
    this._shopPicked = false;
    this.pausedBadge = document.getElementById('paused-badge');
    // Daily Gauntlet result banner (server 'dailyResult' broadcast).
    this.dailyResultsEl = document.getElementById('daily-results');
    this.dailyResultsEl?.addEventListener('click', () => this.hideDailyResults());
    // Elite spawn toast (server 'eliteSpawn' broadcast / LocalRoom emit hook).
    this.eliteToastEl = document.getElementById('elite-toast');
    // BOSS BAR (PRD-wave-finale follow-up): dedicated top bar while a boss
    // (elite name 'Warlord') is alive; schema-polled in the HUD tick.
    this.bossBarEl = document.getElementById('boss-bar');
    this.bossFillEl = document.getElementById('boss-fill');
    this.bossNameEl = document.getElementById('boss-name');
    this.eliteToastEl?.addEventListener('click', () => this.hideEliteToast());
    // Achievement toast (server 'achievementsUnlocked' broadcast).
    this.achievementToastEl = document.getElementById('achievement-toast');
    this.achievementToastEl?.addEventListener('click', () => this.hideAchievementToast());
    // Kill-streak milestone toast ('killStreak' broadcast / LocalRoom emit).
    this.streakToastEl = document.getElementById('streak-toast');
    this.streakToastEl?.addEventListener('click', () => this.hideStreakToast());
    // Presence panel (PRD-presence.md): Online Now list + Recent Allies.
    this.onlineCountEl = document.getElementById('online-count');
    this.onlineListEl = document.getElementById('online-list');
    this.recentAlliesEl = document.getElementById('recent-allies');
    this._presenceInFlight = false;  // guard against overlapping fetches
    this._lastPresenceKey = '';      // last rendered payload signature
    // Live matches panel (PRD-live-matches.md): rows under the Online Now
    // list, own /api/rooms poller. One delegated click handler serves every
    // re-rendered JOIN button (rows are rebuilt as innerHTML strings).
    this.liveMatchesEl = document.getElementById('live-matches');
    this._roomsInFlight = false;     // guard against overlapping fetches
    this._lastRoomsKey = '';         // last rendered payload signature
    this.liveMatchesEl?.addEventListener('click', (e) => {
      // Arena rows carry a SPECTATE button (PRD-arena-spectate) — checked
      // first so it can't fall through into the JOIN branch below.
      const spec = e.target.closest('.spectate-btn');
      if (spec && !spec.disabled) { this.spectateMatch(spec.dataset.roomId); return; }
      const btn = e.target.closest('.join-btn');
      if (btn && !btn.disabled) this.joinMatch(btn.dataset.mode);
    });
    // Arena Spectate: fixed LEAVE pill, hidden until spectateMatch() shows it.
    this.spectateLeaveEl = document.getElementById('spectate-leave');
    this.spectateLeaveEl?.addEventListener('click', () => this.leaveSpectate());
    this.spectating = false;         // read-only arena viewer (never set by normal joins)
    this.isArenaSession = false;     // are we in an arena (PvP) room?

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
    // Mode choice persists like the name/character; waves is the default.
    const savedMode = localStorage.getItem('opengame.mode');
    this.mode = MODES.some((m) => m.key === savedMode) ? savedMode : 'waves';
    this.buildModePicker();
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
    // Presence panel runs from boot in every mode — liveliness is the point
    // (PRD-presence.md), including while the player is still on the login
    // screen. Recent Allies render once here and again after each record.
    this.renderRecentAllies();
    this.startPresencePoller();
    // OIDC SSO (PRD-oidc-login.md): returning from the IdP (?login=ok)
    // re-probes /api/me with the fresh cookie; every boot probes once so
    // the sign-in link only appears while the feature is on.
    await this.handleLoginReturn();
    this.refreshOidcState();
  }

  /** Game-mode cards on the login screen (MODES drives it). The Daily and
   *  Weekly cards also pull their modifier line from /api/daily + /api/weekly. */
  buildModePicker() {
    const picker = document.getElementById('mode-picker');
    picker.innerHTML = '';
    MODES.forEach((m) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'char-card' + (m.key === this.mode ? ' selected' : '');
      btn.dataset.mode = m.key;
      btn.textContent = m.label;
      btn.addEventListener('click', () => {
        this.mode = m.key;
        localStorage.setItem('opengame.mode', m.key);
        for (const el of picker.children) el.classList.remove('selected');
        btn.classList.add('selected');
        this.clearGauntletSubs();
        if (m.key === 'daily') this.fetchDailyInfo();
        else if (m.key === 'weekly') this.fetchWeeklyInfo();
      });
      picker.appendChild(btn);
    });
    // A gauntlet mode was the persisted choice: refresh its line right away.
    this.clearGauntletSubs();
    if (this.mode === 'daily') this.fetchDailyInfo();
    else if (this.mode === 'weekly') this.fetchWeeklyInfo();
  }

  /** Only one gauntlet subtitle line is live at a time — switching cards
   *  clears the previous one so the login card never stacks both. */
  clearGauntletSubs() {
    for (const id of ['mode-daily-sub', 'mode-weekly-sub']) {
      const el = document.getElementById(id);
      if (el) el.textContent = '';
    }
  }

  /** Offline personal-best line on the login card (PRD-offline-progression).
   *  rec=null hides the line; every storage touch is guarded so private-mode
   *  browsers degrade to "no line" instead of breaking the menu. */
  renderPersonalBest(rec) {
    try {
      const el = document.getElementById('personal-best');
      if (!el) return;
      if (!rec) { el.textContent = ''; el.style.display = 'none'; return; }
      el.textContent = `BEST WAVE ${rec.bestWave} · BEST SCORE ${rec.bestScore}`;
      el.style.display = 'block';
    } catch { /* menu must survive even a hostile storage */ }
  }

  /** Re-read the offline career from localStorage and repaint the best line
   *  — called wherever we hand control back to the menu. */
  refreshPersonalBest() {
    try {
      this.renderPersonalBest(loadLocalCareer(window.localStorage));
    } catch {
      this.renderPersonalBest(null); // localStorage itself can throw
    }
  }

  /** Daily Gauntlet subtitle: today's modifier label (+ our best score when
   *  the name is already on today's leaderboard). Any failure — static
   *  hosting, tunnel down, non-JSON response — degrades to a quiet
   *  'offline' note; joining still works via the LocalRoom waves fallback. */
  async fetchDailyInfo() {
    const sub = document.getElementById('mode-daily-sub');
    if (!sub) return;
    sub.textContent = 'daily: loading…';
    try {
      // CONFIG.serverUrl is ws(s)://…; the HTTP API lives at the same host.
      const httpBase = CONFIG.serverUrl.replace(/^ws/i, 'http');
      const res = await fetch(`${httpBase}/api/daily`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.dailyInfo = data ?? null;
      const label = data?.modifiers?.label ?? 'unknown modifiers';
      const mine = (data?.leaderboard ?? []).find((r) => r && r.name === this.name);
      sub.textContent = `today: ${label}` + (mine ? ` · your best ${mine.score}` : '');
      // Objectives (PRD-objective-hud.md): surface today's goals right on the
      // card so players know what to chase before joining.
      const goals = (data?.objectives ?? []).map((o) => o?.description).filter(Boolean);
      if (goals.length) sub.textContent += ` · goals: ${goals.join(' / ')}`;
    } catch {
      this.dailyInfo = null;
      sub.textContent = 'daily: offline';
    }
  }

  /** Weekly Gauntlet subtitle: this ISO week's stacked modifier label (+ our
   *  best score when the name is already on this week's leaderboard). Same
   *  degrade-to-'weekly: offline' behavior as fetchDailyInfo above. */
  async fetchWeeklyInfo() {
    const sub = document.getElementById('mode-weekly-sub');
    if (!sub) return;
    sub.textContent = 'weekly: loading…';
    try {
      const httpBase = CONFIG.serverUrl.replace(/^ws/i, 'http');
      const res = await fetch(`${httpBase}/api/weekly`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.weeklyInfo = data ?? null;
      const label = data?.modifiers?.label ?? 'unknown modifiers';
      const mine = (data?.leaderboard ?? []).find((r) => r && r.name === this.name);
      sub.textContent = `this week: ${label}` + (mine ? ` · your best ${mine.score}` : '');
      // Objectives (PRD-objective-hud.md): same treatment as the daily card.
      const goals = (data?.objectives ?? []).map((o) => o?.description).filter(Boolean);
      if (goals.length) sub.textContent += ` · goals: ${goals.join(' / ')}`;
    } catch {
      this.weeklyInfo = null;
      sub.textContent = 'weekly: offline';
    }
  }

  // ===================== OIDC SSO (PRD-oidc-login.md) =====================

  /** Probe GET /api/me once while the menu is up: verified:true -> show the
   *  VERIFIED pill; any !ok (404 = feature off server-side) or a network
   *  failure hides the badge AND the sign-in link — the menu keeps working
   *  as pure guest play either way. Same ws->http base as the daily APIs. */
  async refreshOidcState() {
    if (!this.ssoLoginEl && !this.verifiedBadgeEl) return;
    let featureOn = false;
    let verified = false;
    try {
      const httpBase = CONFIG.serverUrl.replace(/^ws/i, 'http');
      const res = await fetch(`${httpBase}/api/me`);
      if (res.ok) {
        featureOn = true;
        verified = (await res.json())?.verified === true;
      }
    } catch { /* unreachable / static hosting: stay guest-only */ }
    this.verifiedSession = featureOn && verified;
    this.setVerifiedBadge(featureOn && verified);
    this.setSsoLoginVisible(featureOn);
  }

  /** Single-use join ticket for verified sessions (PRD-name-guard.md).
   *  Guests / feature-off / failures yield null — joins stay unchanged. */
  async ticketForJoin() {
    if (!this.verifiedSession) return null;
    return fetchJoinTicket();
  }

  /** IdP round trip returns to /?login=ok: re-read /api/me now that the
   *  session cookie is fresh, then strip ONLY the login param via
   *  replaceState (?server= and ?touch=1 belong to other readers). */
  async handleLoginReturn() {
    const params = new URLSearchParams(location.search);
    if (!params.has('login')) return;
    if (params.get('login') === 'ok') await this.refreshOidcState();
    params.delete('login');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
  }

  /** Navigate into the BFF's authorize redirect with the CURRENT name-input
   *  value (the callback binds it to the account); empty falls back to the
   *  same default the join path uses. */
  startSsoLogin() {
    const name = this.loginName.value.trim().slice(0, 16) || 'player';
    location.href = `/auth/login/start?name=${encodeURIComponent(name)}`;
  }

  setVerifiedBadge(on) {
    if (this.verifiedBadgeEl) this.verifiedBadgeEl.style.display = on ? 'inline-block' : 'none';
  }

  setSsoLoginVisible(on) {
    if (this.ssoLoginEl) this.ssoLoginEl.style.display = on ? 'inline-block' : 'none';
  }

  // ===================== Presence panel (PRD-presence.md) =================

  /** Poll GET /api/players every 5s against the same host as the daily API
   *  and render the Online Now list. Runs from boot in every mode; any
   *  failure flips the panel to its OFFLINE state instead of throwing. */
  startPresencePoller() {
    this.pollPresence(); // first paint without waiting a full interval
    this._presenceTimer = setInterval(() => this.pollPresence(), 5000);
    // PRD-live-matches.md: LIVE MATCHES rides the same family and timing —
    // its own 5s fetch of /api/rooms against the same http base.
    this.pollRooms();
    this._roomsTimer = setInterval(() => this.pollRooms(), 5000);
  }

  async pollPresence() {
    if (!this.onlineListEl || this._presenceInFlight) return;
    this._presenceInFlight = true;
    try {
      // CONFIG.serverUrl is ws(s)://… — same ws->http derivation as above.
      const httpBase = CONFIG.serverUrl.replace(/^ws/i, 'http');
      const res = await fetch(`${httpBase}/api/players`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.renderPresence(data);
    } catch {
      this.renderPresence(null);
    } finally {
      this._presenceInFlight = false;
    }
  }

  /** Render { count, players: [{name, mode}] } into #online-panel. Cheap:
   *  the DOM is only touched when the payload actually changed. */
  renderPresence(data) {
    if (!this.onlineListEl || !this.onlineCountEl) return;
    const key = data ? JSON.stringify(data.players ?? null) : 'offline';
    if (key === this._lastPresenceKey) return;
    this._lastPresenceKey = key;
    if (!data || !Array.isArray(data.players)) {
      this.onlineCountEl.textContent = 'ONLINE —';
      this.onlineListEl.innerHTML = '<li class="presence-offline">OFFLINE</li>';
      return;
    }
    this.onlineCountEl.textContent = `ONLINE ${data.count ?? data.players.length}`;
    this.onlineListEl.innerHTML = data.players.map((p) =>
      `<li class="presence-row"><span class="dot mode-${esc(p?.mode ?? 'idle')}"></span>${esc(p?.name ?? '???')}</li>`
    ).join('');
  }

  /** PRD-live-matches.md: poll GET /api/rooms every 5s against the same
   *  host as the presence/daily APIs. Overlap-guarded like pollPresence;
   *  any failure silently clears the section — a stale listing misleads
   *  more than an empty one. */
  async pollRooms() {
    if (!this.liveMatchesEl || this._roomsInFlight) return;
    this._roomsInFlight = true;
    try {
      // CONFIG.serverUrl is ws(s)://… — same ws->http derivation as above.
      const httpBase = CONFIG.serverUrl.replace(/^ws/i, 'http');
      const res = await fetch(`${httpBase}/api/rooms`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.renderRooms(Array.isArray(data?.rooms) ? data.rooms : null);
    } catch {
      this.renderRooms(null);
    } finally {
      this._roomsInFlight = false;
    }
  }

  /** Render [{ roomId, mode, players, phase, canJoin }] into #live-matches.
   *  Cheap: the DOM is only touched when the payload actually changed.
   *  Joinable rows get a JOIN button (handled by one delegated listener on
   *  the UL); everything else renders muted with meta only — EXCEPT arena
   *  rooms (PRD-arena-spectate): never joinable mid-match, always watchable,
   *  so a SPECTATE button rides those rows whether canJoin is set or not.
   *  The server already sorts rooms by players desc — the order is kept. */
  renderRooms(rooms) {
    if (!this.liveMatchesEl) return;
    const key = rooms ? JSON.stringify(rooms) : 'offline';
    if (key === this._lastRoomsKey) return;
    this._lastRoomsKey = key;
    if (!rooms) { this.liveMatchesEl.innerHTML = ''; return; }
    if (rooms.length === 0) {
      this.liveMatchesEl.innerHTML = '<li class="presence-offline">no live matches</li>';
      return;
    }
    this.liveMatchesEl.innerHTML = rooms.map((r) => {
      const eyes = Number(r?.spectators) || 0;
      const meta = `${esc(r?.mode ?? '?')} · ${Number(r?.players) || 0}p` +
        (eyes > 0 ? ` · 👁${eyes}` : '');
      // Waves/daily/weekly rooms are spectatable too (PRD-waves-spectate.md)
      const spectateBtn = r?.roomId && r?.mode !== 'world' && r?.mode !== 'lobby'
        ? `<button type="button" class="spectate-btn" data-room-id="${esc(r.roomId)}">SPECTATE</button>`
        : '';
      if (!r?.canJoin) {
        return spectateBtn
          ? `<li class="match-row"><span class="match-meta">${meta}</span>${spectateBtn}</li>`
          : `<li class="match-row muted"><span class="match-meta">${meta}</span></li>`;
      }
      const mode = r.mode === 'daily' ? 'daily' : 'waves';
      return `<li class="match-row"><span class="match-meta">${meta}</span>` +
        `<button type="button" class="join-btn" data-mode="${esc(mode)}">JOIN</button>${spectateBtn}</li>`;
    }).join('');
  }

  /** One-click join from a LIVE MATCHES row (PRD-live-matches.md). Only
   *  waves/daily rooms are ever listed as joinable; the room's family is
   *  forced onto this.mode ('daily' stays daily, everything else maps to
   *  waves), persisted like the login picker, and then the EXACT hosted
   *  path onJoinClick uses takes over — same name/audio/model setup, same
   *  typed-server probe, joinGame('game'|'daily') -> adoptRoom. That also
   *  keeps the offline fallback intact: if the server dropped between the
   *  listing and the click, waves/daily degrade to the browser-local solo
   *  exactly like a normal login join would. */
  async joinMatch(roomMode) {
    if (this.joining || this.room) return; // mid-join or scene already connected
    this.mode = roomMode === 'daily' ? 'daily' : 'waves';
    try { localStorage.setItem('opengame.mode', this.mode); } catch {}
    // Keep the picker in step so an error-path return shows the forced pick.
    for (const el of document.getElementById('mode-picker')?.children ?? []) {
      el.classList.toggle('selected', el.dataset?.mode === this.mode);
    }
    // Double-click guard: freeze every JOIN row now; onJoinClick flips
    // this.joining synchronously, re-enabling happens once it settles.
    for (const b of this.liveMatchesEl.querySelectorAll('.join-btn')) b.disabled = true;
    await this.onJoinClick();
    if (!this.room && this.loginEl.classList.contains('visible')) {
      for (const b of this.liveMatchesEl.querySelectorAll('.join-btn')) b.disabled = false;
    }
  }

  /** Recent Allies: localStorage memory of arena co-participants —
   *  [{name, lastSeenAt}] deduped by name (move-to-front), capped at 20. */
  loadRecentAllies() {
    try {
      const list = JSON.parse(localStorage.getItem('opengame.recentAllies') ?? '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  recordRecentAlly(name) {
    try {
      const n = String(name ?? '').trim().slice(0, 16);
      if (!n || n === this.name) return;
      const rest = this.loadRecentAllies().filter((a) => a && a.name !== n);
      const list = [{ name: n, lastSeenAt: Date.now() }, ...rest].slice(0, 20);
      localStorage.setItem('opengame.recentAllies', JSON.stringify(list));
      this.renderRecentAllies();
    } catch {} // storage disabled / quota errors must never break gameplay
  }

  /** Static section under the Online Now panel; renders on boot and after
   *  each record. Shows a muted placeholder when empty. */
  renderRecentAllies() {
    if (!this.recentAlliesEl) return;
    const ago = (ms) => {
      if (!ms) return '';
      const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      if (s < 60) return 'now';
      if (s < 3600) return `${Math.floor(s / 60)}m`;
      if (s < 86400) return `${Math.floor(s / 3600)}h`;
      return `${Math.floor(s / 86400)}d`;
    };
    this.recentAlliesEl.innerHTML =
      this.loadRecentAllies()
        .filter((a) => a && a.name)
        .map((a) =>
          `<li class="ally-row"><span>${esc(a.name)}</span><span class="ally-time">${ago(Number(a.lastSeenAt))}</span></li>`
        ).join('') || '<li class="presence-offline">none yet</li>';
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
    // Adaptive music director rides the same ctx/master (PRD-music-director.md).
    this.music = new MusicDirector({ sound: this.sound });
    try {
      this.isArenaSession = false; // re-decided below if this join is PvP
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
      if (!online && !MODES.find((m) => m.key === this.mode)?.offline) {
        // PvP needs opponents + matchmaking; the open world needs the hosted
        // chunked room. Neither exists in the browser-local solo simulation.
        throw new Error('this mode needs the game server online — start it (npm run serve) or pick Waves, Daily or Weekly, which also work offline');
      }
      if (this.mode === 'pvp') {
        await this.joinPvpLobby(); // resolves once the arena room is adopted
      } else if (this.mode === 'world') {
        this.enterWorldVisuals();
        this.adoptRoom(await joinWorld(this.name, this.character, await this.ticketForJoin()));
      } else if (online) {
        // Waves/Daily/Weekly share the hosted path — joinGame routes the
        // gauntlet modes to their seeded rooms; waves keeps the classic arena.
        this.adoptRoom(await joinGame(this.name, this.character, this.mode, await this.ticketForJoin()));
      } else {
        // No server (static hosting, host offline): same wire-up, but the
        // room is a browser-local simulation — single-player only. Daily
        // degrades to plain local waves (no streak recorded — accepted).
        // ENDLESS WAR: offline runs never end on score or finale arc.
        this.room = new LocalRoom({ endless: true });
        this.isLocalRun = true; // OFFLINE CAREER: fold endings into localStorage
        // OFFLINE PROGRESSION (PRD-offline-progression.md): endless play never
        // ends, so each cleared wave checkpoints {runs,bestWave,bestScore}
        // straight into localStorage and repaints the login-card best line.
        this.room.onCheckpoint = (rec) => {
          try { saveLocalCareer(window.localStorage, rec); } catch { /* private mode */ }
          this.renderPersonalBest(rec);
        };
        await this.room.join(this.name, this.character);
        this.setNetBadge(false);
        this.wireRoom();
        this.touchControls?.show();
      }
    } catch (err) {
      console.error(err);
      this.loginError.textContent = joinErrorMessage(err);
      this.loginError.style.display = 'block';
      // Re-show the form: the error div lives inside the login card, which
      // was hidden for the join — an invisible error helps nobody.
      this.loginEl.classList.add('visible');
      this.refreshPersonalBest();
    }
    this.joining = false;
  }

  /** Shared tail of every hosted join path: room adopted, wire it up. */
  adoptRoom(room) {
    this.room = room;
    this.setNetBadge(true);
    this.wireRoom();
    this.touchControls?.show();
  }

  /** PvP (Phase 5): join the lobby, queue for an FFA match, follow the seat
   * reservation redirect into the fresh ArenaRoom. Resolves only when the
   * arena room has been adopted — the caller's error path stays in charge
   * until then. */
  async joinPvpLobby() {
    const lobby = await joinLobby(this.name, this.character);
    this.hudText.textContent = 'queued for PvP — waiting for players...';
    lobby.onStateChange((state) => {
      if (state && state.queueCount > 0) {
        this.hudText.textContent = `queued for PvP — ${state.queueCount} in queue`;
      }
    });
    const reservation = await new Promise((resolve, reject) => {
      lobby.onMessage('redirect', resolve);
      lobby.onError((code, message) => reject(new Error(`lobby error: ${message ?? code}`)));
      // FFA, PvP on, first to 2 round wins — the queue message is what
      // actually enters the matchmaking pool (joining alone is not enough).
      sendQueue(lobby, 'ffa', false, 2);
    });
    // Deliberate leave (CONSENTED): the reserved arena seat replaces it.
    lobby.leave(4000);
    const arena = await consumeReservation(reservation);
    this.isArenaSession = true;
    this.adoptRoom(arena);
  }

  // ==================== Arena Spectate (PRD-arena-spectate) ===============

  /** Watch a live arena room straight from its LIVE MATCHES row. The server
   *  grants NO player seat (state.players never holds our sessionId), so
   *  every combatant renders through the remotePlayers path and the camera
   *  follows the action instead of a local rig. Mirrors onJoinClick's
   *  model/probe/error tail so the login card behaves identically when the
   *  room vanished or the server dropped between listing and click. */
  async spectateMatch(roomId) {
    if (!roomId || this.room || this.joining || this.spectating) return;
    this.joining = true;
    try {
      if (!this.models) {
        this.models = await this.loadModels();
        this.scatterProps();
      }
      document.getElementById('loading').style.display = 'none';
      this.loginEl.classList.remove('visible');
      this.loginError.style.display = 'none';
      this.name = this.loginName.value.trim().slice(0, 16) || 'spectator';
      localStorage.setItem('opengame.name', this.name);
      // A typed server wins over the probed default (same rule as joins).
      const rawServer = this.loginServer.value.trim();
      if (rawServer && setServerUrl(rawServer) && CONFIG.serverUrl !== this.probedUrl) {
        this.probedUrl = CONFIG.serverUrl;
        this.serverOnline = serverAvailable();
      }
      await this.serverOnline;
      // Clicking SPECTATE is a user gesture: unlock audio like a join does.
      this.sound.init();
      this.music ??= new MusicDirector({ sound: this.sound });
      this.room = await spectateMatch(roomId, this.name);
      this.spectating = true;
      this.cameraRigged = false; // spectator rig snaps on its first frame
      if (this.netBadge) {
        this.netBadge.textContent = 'SPECTATING';
        this.netBadge.style.display = 'block';
      }
      if (this.spectateLeaveEl) this.spectateLeaveEl.style.display = 'block';
      // No match HUD without a seat — one static line replaces it instead.
      this.hudText.textContent = 'spectating live match';
      this.hudFill.style.width = '0%';
      this.wireRoom(); // local-null-safe: no addPlayer for our sessionId
    } catch (err) {
      console.error(err);
      this.loginError.textContent = joinErrorMessage(err);
      this.loginError.style.display = 'block';
      this.loginEl.classList.add('visible');
      this.refreshPersonalBest();
    }
    this.joining = false;
  }

  /** Spectator rig: follow the first remote player with the SAME third-
   *  person constants as the local rig (CONFIG.player.camera via
   *  cameraOffset/frameDamp); when nobody is on the field yet, orbit the
   *  map center slowly until a target appears. */
  updateSpectatorCamera(dt) {
    const cfg = CONFIG.player.camera;
    let target = null;
    for (const rp of this.remotePlayers.values()) { target = rp.root.position; break; }
    if (target) {
      const off = cameraOffset(cfg.yaw, cfg.distance);
      const desired = new THREE.Vector3(target.x + off.x, cfg.height, target.z + off.z);
      if (!this.cameraRigged) { this.camera.position.copy(desired); this.cameraRigged = true; }
      this.camera.position.lerp(desired, frameDamp(cfg.lerp, dt));
      this.camera.lookAt(target);
    } else {
      const t = performance.now() / 1000;
      const r = cfg.distance + 6;
      this.camera.position.set(Math.cos(t * 0.12) * r, cfg.height, Math.sin(t * 0.12) * r);
      this.camera.lookAt(0, 0, 0);
      this.cameraRigged = false; // re-snap once someone spawns
    }
  }

  /** Manual exit (fixed LEAVE pill): consented leave + full local reset. */
  leaveSpectate() {
    if (!this.spectating) return;
    try { this.room?.leave(4000); } catch {}
    this.endSpectate();
  }

  /** Tear down spectator state and return to the menu. Shared by the LEAVE
   *  click and by wireRoom's onLeave (the match ending closes the room under
   *  us); safe to run twice. */
  endSpectate() {
    this.spectating = false;
    this.room = null;
    this.cameraRigged = false;
    this.disposeEntities();
    this.lastHp = 100;
    this.lastScore = 0;
    this.leaderboardEl.innerHTML = '';
    this.countdownEl.textContent = '';
    if (this.netBadge) {
      this.netBadge.textContent = 'OFFLINE — SOLO MODE (no game server)';
      this.netBadge.style.display = 'none';
    }
    if (this.spectateLeaveEl) this.spectateLeaveEl.style.display = 'none';
    this.loginEl.classList.add('visible');
    this.refreshPersonalBest();
  }

  /** Swap the bounded-arena visuals for the open world (Phase 6): the
   * ChunkManager streams deterministic ground + props, the Minimap rides on
   * top. Both use the default world seed (1337), matching WorldRoom. */
  enterWorldVisuals() {
    if (this.worldMode) return;
    this.worldMode = true;
    // Drop the arena floor/walls/props — the world streams its own ground.
    // Shared resources (dressing geometries, GLB clone sources) are skipped.
    this.scene.remove(this.arenaGroup);
    this.arenaGroup.traverse((o) => {
      if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) if (!m.userData?.shared) m.dispose();
    });
    this.props.length = 0;
    this.chunkManager = new ChunkManager(this.scene, 1337);
    this.minimap = new Minimap({ worldSeed: 1337 });
    this.minimap.attachChunkManager(this.chunkManager);
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
    // Phase 6: the world room broadcasts chunk activations. The client
    // generates identical chunks deterministically, so this only needs to
    // make sure the chunk is present (idempotent).
    this.room.onMessage('chunksLoad', (msg) => {
      if (!this.worldMode || !this.chunkManager) return;
      for (const c of msg?.chunks ?? []) {
        this.chunkManager.loadChunk(`${c.cx},${c.cz}`);
      }
    });
    this.room.onMessage('upgradeResult', (d) => {
      const name = getUpgrade(d?.picked)?.name ?? d?.picked ?? '';
      const suffix = d?.auto ? ' (auto)' : '';
      if (name) this.floatTexts.spawn(this.local?.root.position.x ?? 0, 2.6, this.local?.root.position.z ?? 0, name + suffix, '#a5d6a7');
    });
    this.room.onMessage('shopResult', (d) => {
      const n = d?.picked ?? '';
      if (n) this.floatTexts.spawn(this.local?.root.position.x ?? 0, 2.6, this.local?.root.position.z ?? 0, `SHOP: ${n}`, '#4fc3f7');
    });
    // Daily Gauntlet: run-finalize broadcast (daily rooms only). LocalRoom
    // never emits it — registering here is harmless there.
    this.room.onMessage('dailyResult', (d) => this.showDailyResults(d));
    // CAREER STATS (PRD-career-stats.md): results overlay appends the local
    // player's lifetime line from the end-of-match broadcast.
    this.careerBySid = {};
    // Previous tier per sid — hydrated from localStorage so FIRST-session
    // unlocks toast too, and re-saved on every observation (fail-soft).
    this.lastTierSeen = { ...(JSON.parse(localStorage.getItem('ashfall-lasttier') ?? 'null') ?? {}) };
    this.room.onMessage('careerUpdate', ({ rows }) => {
      for (const row of rows ?? []) {
        const prev = this.lastTierSeen[row.sid];
        if (prev !== undefined && row.tier > prev &&
            row.sid === this.room.sessionId) {
          this.showEliteToast({
            name: `COSMETIC TIER ${row.tier} UNLOCKED`,
            boss: false,
          });
        }
        this.lastTierSeen[row.sid] = row.tier;
        if (row.wasBestWave && row.sid === this.room.sessionId) {
          this.showEliteToast({ name: 'NEW BEST WAVE REACHED', boss: false });
        }
        try {
          localStorage.setItem('ashfall-lasttier', JSON.stringify(this.lastTierSeen));
        } catch {}
        this.careerBySid[row.sid] = row.career;
      }
    });
    // Elite affixes (P2.6): hosted rooms broadcast 'eliteSpawn' {name} and
    // LocalRoom fans the same type out through its onMessage API (see its
    // _emitMessage), so ONE registration covers online + offline waves.
    this.room.onMessage('eliteSpawn', (d) => this.showEliteToast(d));
    // Kill streaks (PRD-kill-streaks.md): both room types broadcast/emit
    // 'killStreak' through this same message API at milestones only. Every
    // client toasts + pitch-blips; the streaking player also gets extra
    // trauma and a gold 1.5x number (see showStreakToast).
    this.room.onMessage('killStreak', (d) => this.showStreakToast(d));
    // Achievements (PRD-achievements.md): rooms broadcast 'achievementsUnlocked'
    // {ids} at finalize paths; names resolve via the shared ACHIEVEMENTS table.
    this.room.onMessage('achievementsUnlocked', (d) => this.showAchievementToast(d));

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
    // exhausted) -> manual retry loop. Spectators have no seat to resume:
    // a closed match just returns them to the menu.
    this.room.onLeave((code) => {
      if (this.spectating) { this.endSpectate(); return; }
      if (code !== 4000) this.handleDisconnect();
      this.recordArenaSessionAllies();
    });
  }

  /** Recent Allies hook (PRD-presence.md): no server message lists arena
   *  participants today, so when an ARENA session ends we snapshot the
   *  other names straight off room.state.players. Defensive end to end:
   *  leaving a room must never throw, even mid-disconnect. */
  recordArenaSessionAllies() {
    try {
      if (this.isArenaSession && this.room?.state?.players) {
        for (const p of this.room.state.players.values()) {
          if (p?.name) this.recordRecentAlly(p.name);
        }
      }
    } catch {}
    this.isArenaSession = false; // the next join decides the new mode
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
          // Fresh join after reconnect: daily players land back in the seeded
          // daily room; every other mode keeps its previous behavior.
          this.isArenaSession = false; // joinGame is never an arena room
          this.room = await joinGame(this.name, this.character,
            this.mode === 'daily' ? 'daily' : undefined, await this.ticketForJoin());
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
    e.onDamage = (pos, amount) => {
      this.floatTexts.spawn(pos.x, pos.y, pos.z, amount, '#ffd54f');
      // Own melee hit-confirm juice (PRD layer 2): the server does not
      // attribute hits, so treat a damage tick landing within melee reach
      // of OUR character as our swing connecting. Render-only.
      const me = this.local?.root.position;
      if (me && Math.hypot(me.x - pos.x, me.z - pos.z) <= SERVER.player.attackRange + 0.6) {
        this.addTrauma(0.15);
        this.hitStopUntil = Math.max(this.hitStopUntil, performance.now() + 50);
      }
    };
    this.enemies.set(i, e);
  }

  /** Create an orb mesh — crystal orb (Icosahedron + emissive pulse, Phase 5). */
  addOrb(i, orb) {
    const mesh = new THREE.Mesh(
      makeOrbGeometry(),
      new THREE.MeshStandardMaterial({ color: CONFIG.colors.orb, emissive: 0x22aa22, emissiveIntensity: 0.6 })
    );
    mesh.name = 'orb';
    mesh.userData.pickupType = 'orb';
    mesh.position.set(orb.x, CONFIG.orb.y, orb.z);
    this.scene.add(mesh);
    this.orbViews[i] = { mesh, state: orb };
    this.applyOrbChargeLook(this.orbViews[i]);
  }

  /** Charged kill-orbs read gold with a hot emissive; plain orbs stay green.
   *  Polled from the per-frame orb sync so charge flips (collect/teleport)
   *  revert instantly without extra schema callbacks. */
  applyOrbChargeLook(view) {
    const charged = (view.state?.charge ?? 0) > 0;
    const mat = view.mesh.material;
    if (!mat || mat._charged === charged) return;
    // Charged -> plain means the orb was COLLECTED: pay a distinct chime.
    if (mat._charged === true && !charged) this.sound?.charged?.();
    mat._charged = charged;
    mat.color.setHex(charged ? 0xffd700 : CONFIG.colors.orb);
    mat.emissive.setHex(charged ? 0x8a6d00 : 0x22aa22);
    mat.emissiveIntensity = charged ? 0.95 : 0.6;
  }

  /** Create a power-up with distinct silhouette per type (Phase 5).
   *  speed = chevron cone (arrow), shield = translucent bubble sphere,
   *  double = stacked coins (two cylinders in a Group). */
  addPowerUp(i, pu) {
    const type = pu.type || 'speed';
    const color = CONFIG.powerUps.colors[type] ?? 0xffffff;
    let mesh;
    if (type === 'speed') {
      mesh = new THREE.Mesh(
        makeSpeedGeometry(),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.75 })
      );
      mesh.rotation.x = Math.PI; // point forward (chevron silhouette)
    } else if (type === 'shield') {
      mesh = new THREE.Mesh(
        makeShieldGeometry(),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7, transparent: true, opacity: 0.85 })
      );
    } else if (type === 'magnet') {
      // Horseshoe magnet silhouette (PRD-magnet.md): half-torus, opening down.
      mesh = new THREE.Mesh(
        new THREE.TorusGeometry(0.32, 0.11, 8, 20, Math.PI),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7 })
      );
    } else { // double — coin stack Group
      mesh = makeDoubleGroup(color);
    }
    mesh.name = `powerup-${type}`;
    mesh.userData.pickupType = type;
    mesh.position.set(pu.x, CONFIG.powerUps.y, pu.z);
    this.scene.add(mesh);
    this.powerUpViews[i] = { mesh, state: pu, color, type };
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
      // Enemy-owned arrows (Shooter archetype) render red-shifted so incoming
      // fire reads as danger at a glance — research lesson #10/#11.
      const hostile = proj.ownerIsPlayer === false;
      const color = hostile ? 0xff5252 : cfg.color;
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(cfg.scale, cfg.scale * 0.5, cfg.height, 6),
        new THREE.MeshStandardMaterial({ color, emissive: hostile ? 0xb71c1c : cfg.emissive, emissiveIntensity: 0.6 })
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

  /** Procedural grass ground: canvas texture, drawn once and reused.
   * ARTWORK_PLAN phase 3: 1024 tile, irregular mottling (no hard grid),
   * soft dirt rings near spawn, hedge/bush bounds dressing. */
  buildGround() {
    const rng = makeRng(1337);
    const size = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3f7d46';
    ctx.fillRect(0, 0, size, size);
    // Irregular mottling — blotchy grass variation instead of a hard grid.
    for (let i = 0; i < 1600; i++) {
      const x = rng() * size, y = rng() * size;
      const r = 7 + rng() * 18;
      const alpha = 0.07 + rng() * 0.13;
      ctx.fillStyle = rng() > 0.5 ? `rgba(30,80,35,${alpha})` : `rgba(120,180,90,${alpha})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.55 + rng() * 0.7), rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    // Fine speckles for micro-detail at close range.
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(30,80,35,0.4)' : 'rgba(120,180,90,0.32)';
      const r = 1.5 + rng() * 2.5;
      ctx.fillRect(rng() * size, rng() * size, r, r);
    }
    // Soft dirt path rings near spawn (canvas center = world 0,0). Three
    // concentric radial gradients + scattered brown mottles inside the radius
    // so the center reads as trampled dirt and the edge stays pure grass.
    const cx = size / 2, cy = size / 2;
    const dirtStops = [
      { rad: 135, inner: 'rgba(110,78,48,0.22)', outer: 'rgba(110,78,48,0)' },
      { rad: 85, inner: 'rgba(95,68,42,0.16)', outer: 'rgba(95,68,42,0)' },
      { rad: 42, inner: 'rgba(105,72,44,0.13)', outer: 'rgba(105,72,44,0)' }
    ];
    for (const { rad, inner, outer } of dirtStops) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, inner);
      g.addColorStop(1, outer);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < 220; i++) {
      const ang = rng() * Math.PI * 2;
      const rad = Math.pow(rng(), 1.15) * 115;
      const x = cx + Math.cos(ang) * rad;
      const y = cy + Math.sin(ang) * rad;
      const r = 4 + rng() * 9;
      ctx.fillStyle = `rgba(110,78,48,${0.09 + rng() * 0.11})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.55 + rng() * 0.6), rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 6);
    tex.needsUpdate = true;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(CONFIG.world.size, CONFIG.world.size),
      new THREE.MeshStandardMaterial({ map: tex })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.arenaGroup.add(ground);

    // Arena walls: faint translucent boxes so the bounds stay readable even
    // after the hedge dressing (ARTWORK_PLAN phase 3 fallback).
    const h = CONFIG.world.size / 2;
    const wallMat = new THREE.MeshBasicMaterial({ color: 0x224466, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
    const mk = (w, d, x, z) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 3, d), wallMat);
      wall.position.set(x, 1.5, z);
      this.arenaGroup.add(wall);
    };
    mk(CONFIG.world.size, 0.5, 0, h);  mk(CONFIG.world.size, 0.5, 0, -h);
    mk(0.5, CONFIG.world.size, h, 0);  mk(0.5, CONFIG.world.size, -h, 0);

    // Hedge / bush bounds: low InstancedMesh ring just inside the walls,
    // one draw call, slight jitter so the hedge feels natural. Walls remain
    // underneath as a readable fallback.
    const bushGeo = makeBushGeometry();
    bushGeo.userData.shared = true;
    const bushMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    bushMat.userData.shared = true;
    const hedgeCount = 56; // 14 per side
    const hedge = new THREE.InstancedMesh(bushGeo, bushMat, hedgeCount);
    hedge.name = 'hedge';
    hedge.castShadow = true;
    hedge.receiveShadow = true;
    const dummy = new THREE.Object3D();
    let idx = 0;
    const inset = 1.2; // distance inside the wall
    const jitterRng = makeRng(4243); // separate stream
    const placeHedge = (x, z) => {
      dummy.position.set(x + (jitterRng() - 0.5) * 0.7, 0, z + (jitterRng() - 0.5) * 0.7);
      dummy.rotation.y = jitterRng() * Math.PI * 2;
      dummy.scale.setScalar(0.85 + jitterRng() * 0.4);
      dummy.updateMatrix();
      hedge.setMatrixAt(idx++, dummy.matrix);
    };
    // Precompute positions: 14 per side, avoiding double-counted corners.
    const seg = (CONFIG.world.size - 2 * inset) / 13; // 13 gaps -> 14 points per side
    // North + South
    for (let i = 0; i < 14; i++) {
      const x = -h + inset + i * seg;
      placeHedge(x, h - inset);
      placeHedge(x, -h + inset);
    }
    // West + East (skip corners already placed)
    for (let i = 1; i < 13; i++) {
      const z = -h + inset + i * seg;
      placeHedge(-h + inset, z);
      placeHedge(h - inset, z);
    }
    hedge.instanceMatrix.needsUpdate = true;
    this.arenaGroup.add(hedge);
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
        this.arenaGroup.add(prop);
        this.props.push(prop);
        return;
      }
    };
    // Scales tuned from the GLB world AABBs (tree 7.6 tall, rock 0.2).
    for (let i = 0; i < 9; i++) place(this.models.tree, 0.8 + rng() * 0.5);
    for (let i = 0; i < 10; i++) place(this.models.rock, 3.5 + rng() * 2.5);

    // Ground cover (ARTWORK_PLAN phase 1): instanced grass + flowers drawn
    // from the SAME seeded stream AFTER the tree/rock draws, so their
    // positions never shift. One draw call each; neither casts shadows
    // (fill-rate budget). Marked shared so world-mode teardown skips them.
    const open = (x, z) => Math.abs(x) >= 7 || Math.abs(z) >= 7; // outside spawn square
    const dummy = new THREE.Object3D();
    const tuftGeo = makeTuftGeometry(0x4e9a4e);
    const tuftMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 1 });
    tuftGeo.userData.shared = true; tuftMat.userData.shared = true;
    const grass = new THREE.InstancedMesh(tuftGeo, tuftMat, 300);
    grass.name = 'grass';
    grass.castShadow = false;
    for (let i = 0; i < 300; i++) {
      const x = -h + rng() * h * 2;
      const z = -h + rng() * h * 2;
      if (!open(x, z)) { i--; continue; }
      dummy.position.set(x, 0, z);
      dummy.rotation.y = rng() * Math.PI * 2;
      dummy.scale.setScalar(0.8 + rng() * 0.7);
      dummy.updateMatrix();
      grass.setMatrixAt(i, dummy.matrix);
    }
    grass.instanceMatrix.needsUpdate = true;
    this.arenaGroup.add(grass);

    const flowerGeo = makeFlowerGeometry();
    const flowerMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    flowerGeo.userData.shared = true; flowerMat.userData.shared = true;
    const flowers = new THREE.InstancedMesh(flowerGeo, flowerMat, 30);
    flowers.name = 'flowers';
    flowers.castShadow = false;
    const palette = [0xff6b6b, 0xffd700, 0xe1bee7, 0xffffff];
    const tint = new THREE.Color();
    for (let i = 0; i < 30; i++) {
      const x = -h + rng() * h * 2;
      const z = -h + rng() * h * 2;
      if (!open(x, z)) { i--; continue; }
      dummy.position.set(x, 0, z);
      dummy.rotation.y = rng() * Math.PI * 2;
      dummy.scale.setScalar(0.9 + rng() * 0.4);
      dummy.updateMatrix();
      flowers.setMatrixAt(i, dummy.matrix);
      flowers.setColorAt(i, tint.setHex(palette[i % palette.length]));
    }
    flowers.instanceMatrix.needsUpdate = true;
    if (flowers.instanceColor) flowers.instanceColor.needsUpdate = true;
    this.arenaGroup.add(flowers);
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

    // World render dt is throttled when globally paused (PVE choosing / shop).
    // UI + overlays still tick at real dt via updateMatchUi below.
    const paused = !!(this.room && this.room.state && this.room.state.paused);
    const dtWorld = paused ? 0 : dt;

    // Music director signals (PRD-music-director.md): cheap per-frame copy
    // from values this frame already computed; damage/milestone timestamps
    // are stamped at their own trigger sites (see _lastDamageAt/_lastMilestoneAt).
    if (this.music) {
      const me = this.local?.state;
      const maxHp = me ? (me.maxHp || CONFIG.player.maxHp) : 0;
      this.music.setSignals({
        matchState: this.room?.state?.matchState ?? '',
        paused,
        hpPct: me && maxHp > 0 ? Math.max(0, Math.min(1, me.hp / maxHp)) : 1,
        eliteActive: !!this.eliteToastEl?.classList.contains('visible'),
      });
      this.music.update(performance.now());
    }

    if (this.local) {
      this.local.update(dtWorld, this.camera);

      // Open world: stream chunks + minimap around the local player. The
      // chunk set is deterministic (same seed as WorldRoom), so this is a
      // pure function of position — no server round trip.
      if (this.worldMode && this.chunkManager) {
        const px = this.local.root.position.x;
        const pz = this.local.root.position.z;
        this.chunkManager.updateForPos(px, pz);
        if (this.minimap) {
          if (this.room?.state?.players) {
            this.minimap.setPlayers(this.room.state.players, this.room.sessionId);
          }
          this.minimap.update(px, pz);
        }
      }

      // Combat radar (PRD-combat-radar.md): match modes only — world keeps its
      // chunk minimap. Single lazily-created instance; hidden outside live
      // matches so menu/gameover states never show stale blips.
      if (!this.worldMode && !this.spectating) {
        const ms = this.room?.state?.matchState;
        const live = !!this.local && ms !== 'lobby' && ms !== 'gameover';
        if (live) {
          if (!this.combatRadar) this.combatRadar = new CombatRadar({ half: 30 });
          const ents = [];
          for (const e of this.enemies.values()) {
            if ((e.state?.hp ?? 0) > 0) ents.push({ x: e.state.x, z: e.state.z });
          }
          for (const [sid, p] of this.room?.state?.players ?? []) {
            if (sid === this.room.sessionId || (p.hp ?? 1) <= 0) continue;
            ents.push({ x: p.x, z: p.z, color: p.color });
          }
          this.combatRadar.canvas.style.display = '';
          this.combatRadar.render(ents, {
            x: this.local.root.position.x,
            z: this.local.root.position.z,
          });
        } else if (this.combatRadar) {
          this.combatRadar.canvas.style.display = 'none';
        }
      }

      // Objectives chip (PRD-objective-hud.md): challenge modes only — live
      // check marks from synced wave/score against /api/{daily,weekly} targets
      // (fetched at menu time; predicates never cross the wire).
      if (!this.worldMode && !this.spectating && this.local) {
        const ms2 = this.room?.state?.matchState;
        if (ms2 === 'playing' || ms2 === 'intermission' || ms2 === 'paused') {
          const defs = this.mode === 'daily' ? this.dailyInfo?.objectives
            : this.mode === 'weekly' ? this.weeklyInfo?.objectives : null;
          if (defs?.length) {
            this._updateObjectivesChip(defs, {
              wave: this.room.state.wave ?? 0,
              score: [...this.room.state.players.values()]
                .find((p) => p.name === this.name)?.score
                ?? this.room.state.players.get(this.room.sessionId)?.score ?? 0,
            });
          } else {
            this._hideObjectivesChip();
          }
        } else {
          this._hideObjectivesChip();
        }
      }

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
      // Trauma shake (PRD layer 2): additive on top of the shakeT path
      // above. Offset scales with trauma² (subtle until it stacks), decays
      // at 1.5/s, clamped to [0,1] by addTrauma + decay here.
      this.trauma = Math.max(0, Math.min(1, this.trauma - dt * 1.5));
      if (this.trauma > 0) {
        const t2 = this.trauma * this.trauma;
        const nowMs = performance.now();
        this.camera.position.x += Math.sin(nowMs * 0.02) * t2 * 0.6;
        this.camera.position.y += Math.sin(nowMs * 0.017 + 2) * t2 * 0.4;
      }
      this.camera.lookAt(target);

      this.updateMatchUi(dt);
    } else if (this.spectating && this.room) {
      // Spectator (PRD-arena-spectate): no local rig, no match HUD, no
      // input — just the follow/orbit camera. The remotePlayers/enemies/
      // projectiles/nametags/leaderboard loops below run unchanged.
      this.updateSpectatorCamera(dt);
    }
    for (const rp of this.remotePlayers.values()) {
      rp.update(dtWorld);
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
    for (const e of this.enemies.values()) e.update(dtWorld, this.camera, w, h);
    const now = performance.now();
    for (const view of this.orbViews) {
      view.mesh.position.x = view.state.x;
      view.mesh.position.z = view.state.z;
      this.applyOrbChargeLook(view); // charged<->plain flip without callbacks
      // Crystal spin + emissive pulse + bob (Phase 5).
      view.mesh.rotation.y += dt * 2;
      view.mesh.rotation.x += dt * 0.85;
      const pulse = 1 + Math.sin(now / 280) * 0.13;
      view.mesh.scale.setScalar(pulse);
      view.mesh.position.y = CONFIG.orb.y + Math.sin(now / 400 + view.state.x * 0.3) * 0.18;
      if (view.mesh.material) view.mesh.material.emissiveIntensity = 0.62 + Math.sin(now / 260) * 0.20;
    }

    // Power-ups: per-type silhouette + pulsing (Phase 5). Distinct rotation per type
    // keeps the three instantly identifiable across the arena.
    for (const view of this.powerUpViews) {
      view.mesh.visible = view.state.active;
      if (!view.state.active) continue;
      view.mesh.position.x = view.state.x;
      view.mesh.position.z = view.state.z;
      const pulse = 1 + Math.sin(now / 180) * 0.16;
      view.mesh.scale.setScalar(pulse);
      view.mesh.position.y = CONFIG.powerUps.y + Math.sin(now / 350 + view.state.x * 0.2) * 0.15;
      const t = view.type ?? view.mesh.userData.pickupType;
      if (t === 'speed') {
        view.mesh.rotation.y += dt * 2.4; // chevron spins faster
        view.mesh.rotation.z = Math.sin(now / 500) * 0.15;
      } else if (t === 'shield') {
        view.mesh.rotation.y += dt * 0.9; // bubble drifts slowly
        // subtle opacity pulse for shield bubble already handled via scale
      } else {
        view.mesh.rotation.y += dt * 1.6; // coin stack
        view.mesh.rotation.x = Math.sin(now / 600) * 0.08;
      }
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

    if (!this.spectating || this.local) this.touchControls?.update();
    // Hit-stop controller (PRD layer 2): while the freeze window is active,
    // FX/anim time is 0 — but ONLY for the cosmetic pools below. State
    // application, network messages, movement and state diffs above keep
    // running at full speed, so multiplayer sync is never gated.
    const fxScale = now < this.hitStopUntil ? 0 : 1;
    this.particles.update(dtWorld * fxScale);
    this.skillFx.update(dtWorld * fxScale);
    this.floatTexts.update(dtWorld * fxScale, this.camera, window.innerWidth, window.innerHeight);
    this.updateNametags();
    this.updateLeaderboard();
    this.updateBossBar();

    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
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
        // WAVE CLEARED popup: now AUTO-ADVANCES after intermissionMs (click
        // still skips the wait). While up every player is invulnerable and
        // the intermission shop is available. Game is paused while choosing.
        this.sound.waveClear();
        this._shopPicked = false;
        this.overlayTitle.textContent = `WAVE ${state.wave} CLEARED!`;
        const remain = state.intermissionUntil ? Math.max(0, Math.ceil((state.intermissionUntil - Date.now()) / 1000)) : 0;
        this.overlaySub.textContent =
          `next wave in ${remain}s — click to skip • shop below — everyone is invulnerable`;
        this.overlay.classList.add('visible');
        this.deadShown = true; // suppress the death overlay underneath
      }
      if (state.matchState === 'gameover') {
        // OFFLINE CAREER (PRD-career-stats.md): the Pages fallback folds its
        // endings into a localStorage career so progression survives reloads.
        // Pure shared math (recordRun/tierForCareer) keeps parity with the
        // server path; private-mode storage failures fail soft.
        if (this.isLocalRun) {
          try {
            const saved = JSON.parse(localStorage.getItem('ashfall-career') ?? 'null');
            const meLocal = state.players.get(this.room.sessionId);
            const career = recordRun(saved?.career ?? null, {
              wave: state.wave,
              score: meLocal?.score ?? 0,
              victory: !!state.victory,
            });
            localStorage.setItem('ashfall-career', JSON.stringify({ ...saved, career }));
            const tier = tierForCareer(career);
            const prevTier = this.lastTierSeen.offline;
            if (prevTier !== undefined && tier > prevTier) {
              this.showEliteToast({ name: `COSMETIC TIER ${tier} UNLOCKED`, boss: false });
            }
            this.lastTierSeen.offline = tier;
            try {
              localStorage.setItem('ashfall-lasttier', JSON.stringify(this.lastTierSeen));
            } catch {}
            // OFFLINE ACHIEVEMENTS: the same pure engine the server runs —
            // daily/weekly predicates fail harmlessly without their blobs.
            const evaluated = evaluateAchievements({ ...saved, career });
            if (evaluated.newIds.length > 0) {
              const names = evaluated.newIds
                .map((id) => achievementById(id)?.name ?? id).join(', ');
              this.showEliteToast({ name: `ACHIEVEMENT — ${names}`, boss: false });
            }
            this.careerBySid[this.room.sessionId] = career;
          } catch { /* storage unavailable — gameplay continues */ }
        }
        // WAVE FINALE (PRD-wave-finale.md): co-op victory reads differently
        // from a death/PvP ending — the run was WON.
        if (state.victory) this.sound.victory?.();
        else this.sound.gameOver();
        this.overlayTitle.textContent = state.victory
          ? 'THE HORDE IS BROKEN — VICTORY!'
          : state.winnerId === this.room.sessionId
            ? 'YOU WIN!' : state.winnerName + ' WINS!';
        const scores = [...state.players.values()]
          .sort((a, b) => b.score - a.score).slice(0, 3)
          .map((p) => `${p.name}: ${p.score}`).join('   ');
        const mine = this.careerBySid?.[this.room.sessionId];
        const careerLine = mine
          ? `   · RUNS ${mine.runs} · WINS ${mine.victories} · BEST WAVE ${mine.bestWave}` : '';
        this.overlaySub.textContent = scores + careerLine + '   — PLAY AGAIN →';
        // SHARE (PRD-share-card.md): one-click copyable run summary on the
        // match-over card only — the death/respawn overlay hides it.
        const me2 = state.players.get(this.room.sessionId);
        const card = buildShareCard({
          mode: this.mode,
          victory: !!state.victory,
          wave: state.wave,
          score: me2?.score ?? 0,
          name: me2?.name,
        });
        this._showShareButton(card);
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
      this._hideShareButton();
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
      this._lastDamageAt = performance.now(); // music director: recent-damage signal
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
    if (me.score > this.lastScore) {
      this.sound.pickup();
      // Own kill/score juice (PRD layer 2): freeze-frame + trauma bump.
      this.addTrauma(0.35);
      this.hitStopUntil = Math.max(this.hitStopUntil, performance.now() + 110);
    }
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

    // Intermission shop (PVE breather: heal / speed / vitality, one pick per player per intermission)
    if (state.matchState === 'intermission') {
      if (!this._shopPicked && this.shopOverlay && !this.shopOverlay.classList.contains('visible')) {
        this._shopIntermWave = state.wave;
        this.shopGrid.innerHTML = '';
        const opts = [
          { id: 'heal', title: 'Heal', desc: 'Restore HP (50% + 20)' },
          { id: 'speed', title: 'Haste', desc: `Speed boost ${Math.round((this.constructor.SPEED_MS ?? 5000)/1000)}s` },
          { id: 'vitality', title: 'Vitality', desc: '+1 Vitality (+30 Max HP, +15 heal)' }
        ];
        opts.forEach((o) => {
          const card = document.createElement('div');
          card.className = 'shop-card';
          card.innerHTML = `<div class="shop-title">${o.title}</div><div class="shop-desc">${o.desc}</div>`;
          card.addEventListener('click', () => {
            sendChooseShop(this.room, o.id);
            this._shopPicked = true;
            this.shopOverlay.classList.remove('visible');
          });
          this.shopGrid.appendChild(card);
        });
        this.shopOverlay.classList.add('visible');
      }
      const shopRemain = state.intermissionUntil ? Math.max(0, Math.ceil((state.intermissionUntil - Date.now()) / 1000)) : 0;
      if (this.shopTimer) this.shopTimer.textContent = this._shopPicked ? 'picked — next wave incoming' : `next wave in ${shopRemain}s`;
      // keep overlay subtitle in sync with countdown too
      if (!this._shopPicked && state.intermissionUntil) {
        this.overlaySub.textContent = `next wave in ${shopRemain}s — click to skip • shop below — everyone is invulnerable`;
      }
    } else {
      if (this.shopOverlay) this.shopOverlay.classList.remove('visible');
      this._shopPicked = false;
      this._shopIntermWave = null;
    }

    // Paused badge (global PVE pause while choosing upgrade)
    if (this.pausedBadge) this.pausedBadge.style.display = state.paused ? 'block' : 'none';

    // HUD: show level + XP alongside score
    this.hudText.textContent =
      `Lv ${me.level} (${me.xp} XP)  wave ${state.wave}  score ${me.score}  players ${state.players.size}  target ${CONFIG.match.targetScore}` +
      (state.matchState === 'intermission' ? '  ★ INVULNERABLE — wave cleared' : '') +
      (state.paused ? '  ⏸ PAUSED' : '') +
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
      const tier = tag.state?.tier ?? 0;
      const tierColor = TIER_COLORS[tier];
      tag.div.textContent =
        `${tier >= 2 ? '\u2605'.repeat(tier - 1) + ' ' : ''}${tag.state.name} ${tag.state.hp}`;
      tag.div.style.borderColor = tierColor ?? tag.color;
      if (tier >= 3) tag.div.style.boxShadow = `0 0 8px ${TIER_COLORS[3]}`;
      else tag.div.style.boxShadow = '';
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

  /** Gauntlet result banner (top-center): one row per finishing player
   *  — name, score, streak multiplier, XP reward. Auto-hides after ~8s;
   *  clicking it dismisses immediately. Weekly runs reuse the same event
   *  name + shape, tagged payload.kind === 'weekly' (header swap only). */
  showDailyResults(payload) {
    const el = this.dailyResultsEl;
    if (!el || !payload) return;
    // Weekly runs carry NO streak (forgiveness is the mechanic) — render
    // the segment only when the row actually has one.
    const rows = (payload.results ?? [])
      .map((r) => {
        const streak = r.streak != null ? ` · streak x${r.streak}` : '';
        return `${esc(r.name)} — score <b>${r.score}</b>${streak} · <b>+${r.rewardXp ?? 0}</b> XP`;
      })
      .join('<br>');
    const title = payload.kind === 'weekly' ? 'WEEKLY GAUNTLET COMPLETE' : 'DAILY GAUNTLET COMPLETE';
    el.innerHTML =
      `<div class="title">${title}</div>` +
      rows +
      '<div style="margin-top:4px;">click to dismiss</div>';
    el.classList.add('visible');
    clearTimeout(this._dailyResultTimer);
    this._dailyResultTimer = setTimeout(() => el.classList.remove('visible'), 8000);
  }

  hideDailyResults() {
    clearTimeout(this._dailyResultTimer);
    this.dailyResultsEl?.classList.remove('visible');
  }

  /** Elite spawn toast (top-center): "⚠ ELITE — SWIFT". Auto-hides after 4s;
   *  clicking it dismisses immediately. Mirrors the daily-results banner
   *  styling (see #elite-toast in index.html). */
  showEliteToast(payload) {
    const el = this.eliteToastEl;
    if (!el) return;
    const isBoss = !!payload?.boss;
    el.innerHTML = isBoss
      ? `<span class="elite-title">☠ BOSS</span> — ${esc(payload?.name ?? 'UNKNOWN')} — SURVIVE THE SURGE`
      : `<span class="elite-title">⚠ ELITE</span> — ${esc(payload?.name ?? 'UNKNOWN')}`;
    // Boss arrivals SHAKE the screen (streaks-era trauma accumulator) — the
    // last stand should be felt, not just read.
    if (isBoss) this.trauma = Math.min(1, (this.trauma ?? 0) + 0.5);
    el.style.borderColor = isBoss ? '#ff5252' : '';
    el.classList.add('visible');
    clearTimeout(this._eliteToastTimer);
    this._eliteToastTimer = setTimeout(() => {
      el.classList.remove('visible');
      el.style.borderColor = '';
    }, isBoss ? 6000 : 4000);
  }

  /** Boss bar: tracks the living Warlord (elite==='Warlord'). Hidden when no
   *  boss exists or it dies — polled every frame from HUD sync. */
  updateBossBar() {
    const el = this.bossBarEl;
    if (!el) return;
    let boss = null;
    for (const e of this.enemies.values()) {
      if (e.state?.elite === 'Warlord' && e.state.hp > 0) { boss = e; break; }
    }
    if (!boss) { el.classList.remove('visible'); return; }
    // Max hp comes from the server's own stamp — accurate under daily-mode
    // modifier scaling where plain waveEnemyHp would understate it.
    const maxHp = boss.state.bossMaxHp > 0
      ? boss.state.bossMaxHp
      : Math.ceil(waveEnemyHp(this.room.state.wave) * 3);
    const pct = Math.max(0, Math.min(1, boss.state.hp / maxHp));
    if (this.bossFillEl) this.bossFillEl.style.width = `${pct * 100}%`;
    el.classList.add('visible');
  }

  /** SHARE pill (PRD-share-card.md): lazily-created button inside the
   *  gameover card; copies the composed share text, acks with COPIED.
   *  Clipboard-unavailable environments degrade to a no-op label. */
  _showShareButton(card) {
    if (!this.shareBtn) {
      const cardEl = this.overlay?.querySelector('.card');
      if (!cardEl) return;
      const btn = document.createElement('button');
      btn.id = 'share-run';
      btn.textContent = 'SHARE';
      btn.style.cssText = 'margin-top:10px;padding:6px 18px;font:inherit;' +
        'background:#1d2330;color:#fff;border:1px solid #44a;cursor:pointer;';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation(); // the overlay itself restarts on click
        try {
          await navigator.clipboard.writeText(this._shareCardText ?? '');
          btn.textContent = 'COPIED';
        } catch { btn.textContent = 'COPY FAILED'; }
        setTimeout(() => { btn.textContent = 'SHARE'; }, 1500);
      });
      cardEl.appendChild(btn);
      this.shareBtn = btn;
    }
    // Stash the latest composition at show-time (click handler reads it).
    this.shareBtn.textContent = 'SHARE';
    this.shareBtn.style.display = '';
    this._shareCardText = shareText(card);
  }

  _hideShareButton() {
    if (this.shareBtn) this.shareBtn.style.display = 'none';
  }

  /** Objectives chip (PRD-objective-hud.md): compact top-center HUD list of
   *  today's/this week's 2 objectives with live check/cross marks. Lazily
   *  created; hidden whenever not in a live challenge match. */
  _updateObjectivesChip(defs, run) {
    if (!this.objectivesChip) {
      const el = document.createElement('div');
      el.id = 'objectives-chip';
      el.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);' +
        'z-index:11;background:#0b0e14cc;padding:4px 12px;border-radius:8px;' +
        'font:12px/1.5 monospace;color:#cfd8ea;text-align:left;pointer-events:none;';
      document.body.appendChild(el);
      this.objectivesChip = el;
    }
    const marks = objectiveProgress(defs.map((d) => d.target ?? {}), run)
      .map((r) => ({ id: r.id, done: r.done }));
    this.objectivesChip.innerHTML = defs.map((d, i) => {
      const done = marks[i]?.done;
      return `<div>${done ? '[x]' : '[ ]'} ${d.description ?? d.id}</div>`;
    }).join('');
    this.objectivesChip.style.display = '';
  }

  _hideObjectivesChip() {
    if (this.objectivesChip) this.objectivesChip.style.display = 'none';
  }

  hideEliteToast() {
    clearTimeout(this._eliteToastTimer);
    this.eliteToastEl?.classList.remove('visible');  }

  /** Kill-streak milestone toast (top-center, gold): "NAME — LABEL (count)".
   *  Fired by the 'killStreak' message from BOTH room types (milestones
   *  only). Everyone gets toast + pitch-rising blip; the streaking player
   *  additionally gets a trauma bump and a gold 1.5x number overhead.
   *  Auto-hides after 3.5s; clicking dismisses. Mirrors #elite-toast
   *  styling (see #streak-toast in index.html). */
  showStreakToast(d) {
    const el = this.streakToastEl;
    if (!el || !d) return;
    this._lastMilestoneAt = performance.now(); // music director: threat signal
    el.innerHTML =
      `<span class="streak-title">${esc(d.name ?? '???')} — ${esc(d.label ?? 'STREAK')}</span> (${Number(d.count) || 0})`;
    el.classList.add('visible');
    clearTimeout(this._streakToastTimer);
    this._streakToastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
    // Pitch rises ~4% per milestone tier via the raw blip() primitive
    // (SoundManager has no pitch param, but takes arbitrary frequencies).
    const tierIdx = MILESTONES.findIndex((m) => m.count === d.count);
    const tier = tierIdx >= 0 ? tierIdx + 1 : 1;
    const f = 620 * Math.pow(1.04, tier);
    this.sound.blip(f, f * 1.6, 0.16, 'triangle', 0.22);
    this.sound.blip(f * 1.6, f * 2.1, 0.2, 'triangle', 0.16, 0.08);
    // Streak is OURS: extra trauma + gold 1.5x floating text at the player.
    if (d.sid != null && d.sid === this.room?.sessionId) {
      this.addTrauma(0.35);
      const p = this.local?.root.position;
      if (p) this.spawnBigFloat(p.x, 3.0, p.z, String(d.label ?? '').toUpperCase(), '#ffd54a');
    }
  }

  hideStreakToast() {
    clearTimeout(this._streakToastTimer);
    this.streakToastEl?.classList.remove('visible');
  }

  /** Achievement unlock toast (top-center, gold): "ACHIEVEMENT UNLOCKED —
   *  <names>". Fired by the 'achievementsUnlocked' broadcast; ids resolve to
   *  human names via the shared ACHIEVEMENTS table (fallback: raw id). Batches
   *  arriving while one is visible are queued and shown 3.5s each; clicking
   *  dismisses everything pending. Mirrors #streak-toast styling (see
   *  #achievement-toast in index.html). */
  showAchievementToast(d) {
    const el = this.achievementToastEl;
    if (!el || !d || !Array.isArray(d.ids)) return;
    const text = d.ids.map((id) => achievementById(id)?.name ?? id).join(', ');
    if (!text) return;
    if (el.classList.contains('visible')) {
      (this._achievementQueue = this._achievementQueue || []).push(text);
      return;
    }
    this._renderAchievementToast(text);
    clearTimeout(this._achievementToastTimer);
    this._achievementToastTimer = setTimeout(() => this._nextAchievementToast(), 3500);
  }

  _renderAchievementToast(text) {
    const el = this.achievementToastEl;
    el.innerHTML =
      `<span class="achievement-title">ACHIEVEMENT UNLOCKED</span> — ${esc(text)}`;
    el.classList.add('visible');
    const p = this.local?.root.position;
    if (p && typeof this.spawnBigFloat === 'function') {
      this.spawnBigFloat(p.x, 3.4, p.z, '★ ACHIEVEMENT ★', '#ffd54a');
    }
  }

  _nextAchievementToast() {
    const next = (this._achievementQueue || []).shift();
    if (!next) return this.hideAchievementToast();
    this._renderAchievementToast(next);
    clearTimeout(this._achievementToastTimer);
    this._achievementToastTimer = setTimeout(() => this._nextAchievementToast(), 3500);
  }

  hideAchievementToast() {
    clearTimeout(this._achievementToastTimer);
    this._achievementQueue = [];
    this.achievementToastEl?.classList.remove('visible');
  }

  /** FloatingTextPool.spawn with a 1.5x font-size bump on the div just
   *  handed out (the pool itself exposes no scale knob — PRD: milestone
   *  numbers render 1.5x gold). */
  spawnBigFloat(x, y, z, text, color) {
    this.floatTexts.spawn(x, y, z, text, color);
    const item = this.floatTexts.items[
      (this.floatTexts.next + this.floatTexts.size - 1) % this.floatTexts.size];
    item.div.style.fontSize = '24px'; // .float-text default 16px * 1.5
  }

  /** Trauma accumulator (PRD layer 2): additive input clamped to [0,1]. */
  addTrauma(amount) {
    this.trauma = Math.min(1, (this.trauma ?? 0) + amount);
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
