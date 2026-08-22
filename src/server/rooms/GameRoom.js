// The one gameplay room. Owns the match lifecycle (LOBBY -> COUNTDOWN ->
// PLAYING -> GAME_OVER) and the fixed-timestep simulation: movement
// integration, shared orb pickups, power-ups, enemy AI, melee, damage and
// knockback. Clients only send input intents — every outcome below is
// authoritative, including the state transitions (clients just render
// matchState + countdown).
//
// SECURITY BOUNDARIES (do not regress):
//   - input direction is validated (finite, magnitude clamped to <= 1) — the
//     server integrates with its own speed, positions never come from clients
//   - input messages are rate-capped per session (net.maxInputPerSecond)
//   - per-IP join rate limiting runs in onAuth below (ratelimit.js token
//     bucket) — the only layer with a trustworthy IP in Colyseus 0.17
//   - names are sanitized (trim, length cap) and the leaderboard HTML is
//     escaped client-side — no XSS surface from user input
import { Room, CloseCode } from 'colyseus';
import { WorldState, PlayerState, OrbState, PowerUpState, EnemyState, ProjectileState } from '../schema/StateSchema.js';
import { SERVER } from '../config.js';
import { log, warn } from '../log.js';
import { takeToken, normalizeIp } from '../ratelimit.js';
import { stepPlayer } from '../movement.js';
import { skillFor, resolveSkillHits, classStats } from '../../shared/skills.js';
// Per-class base stats (Phase 3): hp/speed/melee numbers diverge per class.
const statsOf = (player) => classStats(player.character);
// D1 wave activation lives once in shared/waves.js (P1.3 slice 4 stretch):
// the room injects its square sampler + anim/stun-map clears, keeps the log.
import { activateWave, waveEnemyHp, spawnAwayFromPlayers } from '../../shared/waves.js';
import { blockedHit, meleeHits, strikeEnemy, strikePlayer } from '../../shared/combat.js';
import { attackFor } from '../../shared/classes.js';
// Elite affixes (PRD-elite-affixes.md): pure shared module — every Nth wave
// spawns slot 0 as an ELITE carrying a named affix; both rooms consume the
// same table so online/offline parity is structural, not duplicated logic.
import { isEliteWave, affixForWave, applyElite, affixByName, finaleBossFor } from '../../shared/sim/elites.js';
import { archetypeByName, markArchetypes,
  SHOOTER_PREFERRED_RANGE, SHOOTER_KITE_RANGE, SHOOTER_FIRE_COOLDOWN_MS,
  SHOOTER_KITE_SPEED_MUL, SHOOTER_WINDUP_MS } from '../../shared/sim/archetypes.js';
import * as orbDrops from '../../shared/sim/orbDrops.js';
import { pullOrbs } from '../../shared/sim/magnetPull.js';
import { recordRun } from '../../shared/sim/careerStats.js';
// Kill streaks (PRD-kill-streaks.md): pure shared module — both rooms track
// consecutive credited kills per player (2.5s window, reset on death/reset)
// and announce ONLY at MILESTONES so online/offline payloads stay identical.
import { newStreakState, registerKill, resetSid, resetAll } from '../../shared/sim/streaks.js';
// D2 leveling flow lives once in shared/sim (P1.3 slice 1): XP grant ->
// level-up queue -> card roll -> auto-pick -> manual pick. D5 enemy-hit
// resolution + D4 burn DoT (combatBook) and D3 shop effects (shopEffects)
// followed in slice 2; D6 projectile loop in slice 3; D7 pause wall +
// D8 match reset complete the set in slice 4.
import * as leveling from '../../shared/sim/leveling.js';
import * as combatBook from '../../shared/sim/combatBook.js';
import * as shopEffects from '../../shared/sim/shopEffects.js';
import * as projectileLoop from '../../shared/sim/projectileLoop.js';
import * as matchPhases from '../../shared/sim/matchPhases.js';
import { aggregateBonuses,
         effectiveMaxHp, effectiveSpeedMult, effectiveAttackCdMult, effectiveSkillCdMult,
         effectiveSkill, effectiveMeleeDamage, effectiveRangedDamage, effectivePickupMult } from '../../shared/progression.js';
// Daily Gauntlet (PRD-daily-gauntlet.md): pure date math from shared/sim —
// same module the offline client uses, so server + local runs agree.
import { utcDateStr, dailySeed, dailyModifiers, nextStreak, streakRewardXp } from '../../shared/sim/dailyRun.js';
// Weekly Gauntlet (PRD-weekly-gauntlet.md): ISO-week-seeded runs that reuse
// the entire daily pipeline below — only the seed/modifier source and the
// finalize blob differ (no streak by design; forgiveness is the mechanic).
import { utcWeekKey, weeklySeed, weeklyModifiers, weeklyRewardXp, mergeWeekly } from '../../shared/sim/weeklyRun.js';
// Per-player JSON persistence (WorldRoom pattern): load on finalize, save debounced.
import { loadPlayer, savePlayerDebounced } from '../persistence.js';
// Presence panel (PRD-presence.md): cross-room live population registry.
import { registerPresence, removePresence } from '../presence.js';

// Simple string hash: same name -> same color, stable across joins.
function nameHash(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

// Deterministic RNG (LCG, same pattern as src/LocalRoom.js makeRng): the
// Daily Gauntlet seeds it with the UTC date hash so every player on the same
// day walks an identical layout.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export default class GameRoom extends Room {
  // Hard cap so one room cannot be overloaded (README "Design decisions").
  maxClients = SERVER.match.maxClients;

  // Live-room registry + observability stats, shared with /healthz + /metrics
  // and used by the headless test suite to reach authoritative server state.
  static instances = new Set();
  static stats = { lastTickMs: 0, inputTimes: [] };

  /** Challenge rooms ('daily' | 'weekly') share every gate below: modifiers,
   *  seeded layouts and run finalization never apply to plain 'waves'. */
  get isChallenge() {
    return this.mode === 'daily' || this.mode === 'weekly';
  }

  onCreate(options = {}) {
    GameRoom.instances.add(this);
    // Empty-room cleanup is ours (configurable TTL, documented in README);
    // disable Colyseus' 1s auto-dispose so a gameover room survives for
    // latecomers and the matchmaker reuse logic stays deterministic.
    this.autoDispose = false;

    // Challenge-mode gate — everything below stays byte-for-byte identical
    // for 'waves'. Daily rooms get today's modifiers plus a seeded LCG that
    // replaces Math.random() inside randomPos() so same-day runs are
    // reproducible (AC3/PRD section 2). Weekly rooms mirror the whole path
    // with the ISO week key as seed source and a STACKED modifier row
    // (PRD-weekly-gauntlet.md). Must be set BEFORE the spawns.
    this.mode = options.mode === 'weekly' ? 'weekly'
      : options.mode === 'daily' ? 'daily' : 'waves';
    this.enemySpeedMul = 1;
    if (this.mode === 'daily') {
      const today = utcDateStr();
      this.dailyDate = today;
      this.dailyMods = dailyModifiers(today);
      this._rng = makeRng(dailySeed(today));
      this.enemySpeedMul = this.dailyMods.enemySpeedMul;
      this.logEvent('daily_room_create', { date: today, label: this.dailyMods.label });
    } else if (this.mode === 'weekly') {
      const week = utcWeekKey();
      this.weeklyWeek = week;
      // Same field the daily machinery reads everywhere below (spawnWave
      // sizing/scaling, seeded randomPos) so weekly rides every existing
      // challenge gate unchanged.
      this.dailyMods = weeklyModifiers(week);
      this._rng = makeRng(weeklySeed(week));
      this.enemySpeedMul = this.dailyMods.enemySpeedMul;
      this.logEvent('weekly_room_create', { week, label: this.dailyMods.label });
    }

    this.setState(new WorldState());

    // Per-session scratch state, kept out of the schema (no reason to
    // broadcast input buffers or timers).
    this.inputs = new Map();        // sessionId -> { dirX, dirZ } last intent
    this.attackAt = new Map();      // sessionId -> ms when J may swing again
    this.skillAt = new Map();       // sessionId -> ms when K may cast again
    this.invulnUntil = new Map();   // sessionId -> ms of damage immunity
    this.animUntil = new Map();     // sessionId -> ms anim override ('attack') expires
    this.msgTimes = new Map();      // sessionId -> recent input timestamps (rate cap)
    this.graceTimers = new Map();   // sessionId -> timeout handle for reconnect grace
    this.enemyAnimUntil = new Map();// enemy -> ms of 'hit'/'attack' anim override
    this.enemyStunUntil = new Map();// enemy -> ms of HIT-STUN (no move/attack)
    this.pendingMelee = [];      // {sid, at} — impacts land mid-swing, not at press
    this.powerUpTimers = new Map(); // powerUp -> seconds until it respawns
    this.orbCharges = new Map();    // orb -> stored kill-XP (PRD-orb-drops.md)
    this.shooterFireAt = new Map(); // enemy -> ms of next Shooter volley
    this._projectileId = 0;        // monotonic ID for projectile spawn
    this.pendingUntil = new Map(); // sid -> ms deadline for upgrade auto-pick
    this.pendingQueue = new Map(); // sid -> queued level-ups waiting for card pick
    // Shared-sim context for the D2 leveling flow (src/shared/sim/leveling.js):
    // the room owns state + scratch maps + transport; only clock/hooks wire in.
    this.simLeveling = {
      players: this.state.players,
      pendingUntil: this.pendingUntil,
      pendingQueue: this.pendingQueue,
      now: () => Date.now(),
      emit: (sid, type, data) =>
        this.clients.find((c) => c.sessionId === sid)?.send(type, data),
      log: (event, fields) => this.logEvent(event, fields),
      warn: (event, fields) => this.warnEvent(event, fields),
    };

    this.half = SERVER.world.size / 2; // arena half-extent on X and Z
    this.matchElapsed = 0;          // seconds into the playing phase (timed mode)
    this.lastActiveAt = Date.now(); // empty-room TTL anchor
    // D7 pause-wall bookkeeping as mutable ref holders the shared gate
    // mutates (src/shared/sim/matchPhases.js): until=0 means disarmed.
    this.intermissionBox = { until: 0 };  // ms epoch when intermission auto-advances
    this.pauseBox = { until: 0 };         // ms epoch when global pause cap expires
    this.intermissionShopChoices = new Map(); // sid -> shop pick applied this intermission
    // D4 burn DoT scratch (src/shared/sim/combatBook.js): firewave payload
    // keyed by projectile id, live burns keyed by enemy.
    this._burnByProjId = new Map();
    this._activeBurns = new Map();
    // Elite affix scratch (PRD-elite-affixes.md): pending Volatile explosions
    // keyed by the dead elite's pool slot — armed by combatBook.onEliteKill,
    // drained each playing tick via combatBook.tickVolatile.
    this.volatilePending = new Map();
    // Kill-streak scratch (PRD-kill-streaks.md): sid -> { count, lastAt },
    // fed by creditStreak on every credited kill; LocalRoom mirrors it.
    this.streaks = newStreakState();
    this.waveBaseHp = SERVER.enemy.hp; // per-wave base HP (elite maxHp derives from it)
    // Shared-sim context for D5/D4 combat bookkeeping: the room owns the
    // schema state + scratch maps + transport; only clock/hooks wire in.
    this.simCombat = {
      state: this.state,
      half: this.half,
      players: this.state.players,
      enemyAnimUntil: this.enemyAnimUntil,
      enemyStunUntil: this.enemyStunUntil,
      burnByProjId: this._burnByProjId,
      activeBurns: this._activeBurns,
      volatilePending: this.volatilePending,
      now: () => Date.now(),
      dropOrb: (x, z, amount) =>
        orbDrops.chargeForKill(this.state.orbs, this.orbCharges, x, z, amount),
      grantXp: (sid, amount) => leveling.grantXp(this.simLeveling, sid, amount),
      damagePlayer: (sid, victim, amount, srcX, srcZ) =>
        this.damagePlayer(sid, victim, amount, srcX, srcZ),
      // Elite maxHp is not a schema field: recompute from the wave's base HP
      // scaled by the affix (the exact number applyElite wrote at spawn).
      eliteMaxHp: (enemy) => Math.ceil(this.waveBaseHp * (affixByName(enemy.elite)?.hpMul ?? 1)),
      log: (event, fields) => this.logEvent(event, fields),
    };
    // Shared-sim context for the D6 projectile loop: the loop owns stepping,
    // expiry and collision; the room keeps only WHAT a hit does. The burn
    // maps + clock ride along so fireball hits hand off to the D4 register
    // (combatBook.startBurnFromProjectile) exactly like the old inline call.
    this.simProjectiles = {
      state: this.state,
      half: this.half,
      burnByProjId: this._burnByProjId,
      activeBurns: this._activeBurns,
      now: () => Date.now(),
      onHitEnemy: (proj, enemy) =>
        this.hitEnemy(enemy, proj.damage, proj.x, proj.z, proj.ownerSid),
      onHitPlayer: (proj, osid, victim) =>
        this.damagePlayer(osid, victim, proj.damage, proj.x, proj.z),
    };
    // Shared-sim context for the D3 intermission shop.
    this.simShop = {
      players: this.state.players,
      state: this.state,
      shopChoices: this.intermissionShopChoices,
      emit: (sid, type, data) =>
        this.clients.find((c) => c.sessionId === sid)?.send(type, data),
      log: (event, fields) => this.logEvent(event, fields),
      warn: (event, fields) => this.warnEvent(event, fields),
    };
    // Shared-sim context for the D7 pause wall + D8 match reset
    // (src/shared/sim/matchPhases.js, P1.3 slice 4). The win-while-paused
    // hook keeps the full checkWinConditions(0) here — LocalRoom wires its
    // historical score-only block on its side of the seam.
    this.simPhases = {
      state: this.state,
      players: this.state.players,
      pendingUntil: this.pendingUntil,
      pendingQueue: this.pendingQueue,
      pauseBox: this.pauseBox,
      intermissionBox: this.intermissionBox,
      now: () => Date.now(),
      checkAutoPicks: () => leveling.checkAutoPicks(this.simLeveling),
      checkWinWhilePaused: () => {
        if (this.state.matchState !== 'gameover') this.checkWinConditions(0);
      },
      spawnWave: (n) => this.spawnWave(n),
    };

    this.spawnOrbs();
    this.spawnEnemies();
    this.spawnPowerUps();

    // --- Messages -------------------------------------------------------
    this.onMessage('input', (client, msg) => this.onInput(client, msg));
    this.onMessage('respawn', (client) => this.onRespawn(client));
    this.onMessage('playAgain', (client) => this.onPlayAgain(client));
    // Wave gate: intermission auto-advances after wave.intermissionMs; a
    // 'nextWave' click from ANY player skips the wait for the whole room.
    this.onMessage('nextWave', (client) => this.onNextWave(client));
    this.onMessage('chooseUpgrade', (client, msg) => this.onChooseUpgrade(client, msg));
    this.onMessage('chooseShop', (client, msg) => this.onChooseShop(client, msg));

    // --- Fixed-timestep loop, dt from REAL elapsed time ------------------
    // this.clock.setInterval drifts under load (GC, event-loop stalls); the
    // simulation must integrate with the actual time between ticks so
    // movement/effects stay correct. dt is clamped so a long stall cannot
    // teleport the world.
    this.lastTickAt = Date.now();
    this.clock.setInterval(() => {
      const now = Date.now();
      const dt = Math.min((now - this.lastTickAt) / 1000, 0.25);
      this.lastTickAt = now;
      const t0 = performance.now();
      this.update(dt);
      GameRoom.stats.lastTickMs = performance.now() - t0;
    }, SERVER.tickMs);

    this.logEvent('room_create');
  }

  logEvent(event, fields = {}) {
    log(event, { roomId: this.roomId, ...fields });
  }

  warnEvent(event, fields = {}) {
    warn(event, { roomId: this.roomId, ...fields });
  }

  /** Sanitize the pre-join name (join options) for display everywhere. */
  sanitizeName(raw) {
    const name = String(raw ?? '').trim().slice(0, 16);
    return name || 'player';
  }

  /** Sanitize the pre-join character index: integer clamped to the roster. */
  sanitizeCharacter(raw) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(SERVER.characters.count - 1, n));
  }

  spawnOrbs() {
    for (let i = 0; i < SERVER.orb.count; i++) {
      const p = this.randomPos();
      this.state.orbs.push(new OrbState(p.x, p.z));
    }
  }

  /** Fixed enemy pool (see src/shared/waves.js). Slots beyond the current
   *  wave's count sit dead (hp 0) — the client hides them; spawnWave
   *  revives slots as waves grow, so ids stay stable for everyone. */
  spawnEnemies() {
    for (let i = 0; i < SERVER.enemy.pool; i++) {
      this.state.enemies.push(new EnemyState(0, 0));
    }
    this.spawnWave(1);
  }

  /** Activate wave `n`: the first waveEnemyCount(n) pool slots come alive at
   *  waveEnemyHp(n), spawned away from players; the rest drop dead. Thin
   *  delegate over shared/waves.activateWave (P1.3 slice 4 stretch): the
   *  square sampler + anim/stun-map clears are injected, wave_spawn stays.
   *  Challenge rooms (daily/weekly) extend the sizing with their modifiers:
   *  enemyCountBonus extra slots and every live slot scaled by enemyHpMul
   *  (speed rides a room-level multiplier applied in updatePlaying). */
  spawnWave(n) {
    const { count, hp } = activateWave(
      this.state.enemies, n, this.state.players, () => this.randomPos(),
      (enemy) => {
        this.enemyAnimUntil.delete(enemy);
        this.enemyStunUntil.delete(enemy);
        this.volatilePending.delete(enemy);
        enemy.elite = ''; // slots revive clean; re-marked below on elite waves
        enemy.archetype = ''; // archetype tags are re-stamped by markArchetypes
      });
    let spawned = count;
    let effHp = hp;
    if (this.isChallenge) {
      const mods = this.dailyMods;
      effHp = Math.max(1, Math.round(hp * mods.enemyHpMul));
      spawned = Math.min(count + Math.max(0, Math.floor(mods.enemyCountBonus)),
        this.state.enemies.length);
      // Bonus slots were left dead by activateWave — place them away from
      // players like the base slots, then rescale everyone's HP.
      const hazards = [...this.state.players.values()].filter((p) => p.hp > 0);
      for (let i = count; i < spawned; i++) {
        const p = spawnAwayFromPlayers(hazards, () => this.randomPos());
        this.state.enemies[i].x = p.x;
        this.state.enemies[i].z = p.z;
      }
      for (let i = 0; i < spawned; i++) {
        this.state.enemies[i].hp = effHp;
        this.state.enemies[i].anim = 'idle';
      }
    }
    // FINALE SURGE (PRD-wave-finale.md): the last stand deploys the ENTIRE
    // pool regardless of the growth formula — placed away from players like
    // daily bonus slots. Non-finale waves keep the formula count exactly.
    if (SERVER.wave.finaleWave > 0 && n === SERVER.wave.finaleWave &&
        spawned < this.state.enemies.length) {
      const hazards2 = [...this.state.players.values()].filter((p) => p.hp > 0);
      for (let i = spawned; i < this.state.enemies.length; i++) {
        const pos = spawnAwayFromPlayers(hazards2, () => this.randomPos());
        const e = this.state.enemies[i];
        e.x = pos.x;
        e.z = pos.z;
        e.hp = effHp;
        e.anim = 'idle';
      }
      spawned = this.state.enemies.length;
    }
    this.waveBaseHp = effHp; // elite maxHp derives from the same base everyone got
    // ELITE AFFIXES (PRD-elite-affixes.md): every ELITE_EVERY_N_WAVES-th wave
    // marks slot 0 as the wave's ELITE (deterministic affix per wave number —
    // LocalRoom mirrors this exactly). Broadcast lets clients show the banner.
    // FINALE BOSS (elites.js): on the configured finale wave slot 0 becomes
    // the Warlord instead of any regular rotation elite — the run's last
    // stand gets a face. LocalRoom mirrors byte-for-byte.
    const bossName = finaleBossFor(n, SERVER.wave.finaleWave);
    if (bossName) {
      const boss = applyElite(this.state.enemies[0], bossName, effHp);
      if (boss) {
        this.broadcast('eliteSpawn', { name: boss.name, boss: true });
        this.logEvent('elite_spawn', { wave: n, name: boss.name, boss: true });
      }
    } else if (isEliteWave(n)) {
      const affix = applyElite(this.state.enemies[0], affixForWave(n), effHp);
      if (affix) {
        this.broadcast('eliteSpawn', { name: affix.name });
        this.logEvent('elite_spawn', { wave: n, name: affix.name });
      }
    }
    // ENEMY ARCHETYPES (PRD-enemy-archetypes.md): deterministic per-(wave,
    // slot) tags on every live non-elite slot; LocalRoom mirrors exactly.
    const archMarked = markArchetypes(this.state.enemies, n,
      { liveCount: spawned,
        // slot 0 is off-limits whenever a special occupies it (rotation
        // elite OR finale boss) — otherwise archetype mults restamp its hp.
        eliteWave: isEliteWave(n) || !!bossName });
    if (archMarked > 0) {
      this.logEvent('archetypes_marked', { wave: n, marked: archMarked });
    }
    this.state.wave = n;
    this.logEvent('wave_spawn', { wave: n, enemies: spawned, hp: effHp });
  }

  spawnPowerUps() {
    // One of each type, so all three are always in play.
    const types = Object.keys(SERVER.powerUps).filter((k) =>
      ['speed', 'shield', 'double', 'magnet'].includes(k));
    for (let i = 0; i < SERVER.powerUps.count; i++) {
      const p = this.randomPos();
      this.state.powerUps.push(new PowerUpState(p.x, p.z, types[i % types.length]));
    }
  }

  /**
   * Per-IP connection rate limiting (security boundary, see ratelimit.js):
   * every fresh join consumes a token from the IP's bucket; over-limit IPs
   * are rejected here, before any seat/player state is created. Reconnects
   * keep their client.auth and never reach this hook.
   */
  onAuth(_client, _options, authContext) {
    const ip = normalizeIp(authContext?.ip);
    if (!takeToken(ip)) {
      this.warnEvent('join_rate_limited', { ip });
      // Message contract: must contain "too many join attempts" — the client
      // (joinErrorMessage in src/network.js) matches on it to explain the
      // lockout and how long to wait.
      throw new Error('too many join attempts — wait a few seconds and try again');
    }
    return true; // accept (truthy auth)
  }

  onJoin(client, options = {}) {
    // Reconnect path: a player with a live seat rejoins — keep their
    // position/score/hp, just refresh the connection-scoped scratch state.
    let player = this.state.players.get(client.sessionId);
    if (player) {
      this.logEvent('player_reconnect', { sid: client.sessionId, name: player.name });
    } else {
      const name = this.sanitizeName(options.name);
      const p = this.randomPos();
      player = new PlayerState(p.x, p.z);
      player.name = name;
      player.character = this.sanitizeCharacter(options.character);
      player.hp = statsOf(player).hp; // Phase 3: per-class base HP
      player.color = SERVER.colors[nameHash(name) % SERVER.colors.length];
      // Phase 4: leveling defaults (schema already defaults these, be explicit)
      player.level = 1;
      player.xp = 0;
      while (player.pendingChoices.length) player.pendingChoices.pop();
      player.upgrades.clear();
      this.state.players.set(client.sessionId, player);
      this.logEvent('player_join', { sid: client.sessionId, name, players: this.state.players.size });
    }

    this.inputs.set(client.sessionId, { dirX: 0, dirZ: 0 });
    this.attackAt.set(client.sessionId, 0);
    this.skillAt.set(client.sessionId, 0);
    this.invulnUntil.set(client.sessionId, 0);
    // Late-join fairness (PRD-live-matches.md): arriving mid-match grants a
    // longer spawn-protection window than the standard 1s spawn grace.
    if (this.state.matchState === 'playing') {
      this.invulnUntil.set(client.sessionId, Date.now() + 3000);
    }
    this.animUntil.set(client.sessionId, 0);
    this.msgTimes.set(client.sessionId, []);
    clearTimeout(this.graceTimers.get(client.sessionId));
    this.graceTimers.delete(client.sessionId);

    // Presence panel (PRD-presence.md): one registry row per connected player.
    registerPresence(client.sessionId,
      { name: player.name, mode: this.isChallenge ? this.mode : 'waves', roomId: this.roomId });

    // Match start (documented choice): the countdown begins as soon as the
    // minPlayers threshold is met — default 1, i.e. the first player.
    if (this.state.matchState === 'lobby' && this.state.players.size >= SERVER.match.minPlayers) {
      this.startCountdown();
    } else if (this.state.matchState === 'gameover' && this.state.players.size === 1) {
      // JOIN DURING GAME_OVER (documented choice): a player joining a room
      // where everyone else left gets an instant fresh match — no stranded
      // waiting for a "play again" click that nobody can make.
      this.logEvent('match_auto_restart', { sid: client.sessionId, reason: 'join_during_gameover' });
      this.resetMatch();
    }
  }

  // Colyseus 0.17 calls onLeave with the close CODE (not a boolean) and
  // routes unexpected drops here too. 4000 = deliberate leave; anything
  // else = network drop, so we hold the seat + player state for the grace
  // window: the client reconnects with its token and onJoin re-attaches
  // the same PlayerState (position/score/hp survive — no reload).
  onLeave(client, code = CloseCode.CONSENTED) {
    const sid = client.sessionId;
    removePresence(sid); // connection gone -> off /api/players (grace reconnect re-registers)
    if (code === CloseCode.CONSENTED) {
      this.removePlayer(sid);
      return;
    }
    if (!this.graceTimers.has(sid)) {
      // allowReconnection() rejects with "disposing" while the room is being
      // torn down (server shutdown / test teardown). Swallow that rejection
      // — it used to surface as an unhandled "Error: disposing" stack dump.
      const p = this.allowReconnection(client, SERVER.match.reconnectGraceMs / 1000);
      if (p?.catch) p.catch(() => this.removePlayer(sid));
      const timer = setTimeout(() => this.removePlayer(sid), SERVER.match.reconnectGraceMs);
      this.graceTimers.set(sid, timer);
      this.logEvent('player_drop_grace', { sid, graceMs: SERVER.match.reconnectGraceMs });
    }
  }

  removePlayer(sid) {
    this.state.players.delete(sid);
    this.inputs.delete(sid);
    this.attackAt.delete(sid);
    this.invulnUntil.delete(sid);
    this.animUntil.delete(sid);
    this.msgTimes.delete(sid);
    this.pendingUntil.delete(sid);
    this.pendingQueue?.delete(sid);
    const t = this.graceTimers.get(sid);
    if (t) { clearTimeout(t); this.graceTimers.delete(sid); }
    this.logEvent('player_remove', { sid, players: this.state.players.size });
  }

  onDispose() {
    for (const sid of this.state.players.keys()) removePresence(sid); // error-path cleanup
    GameRoom.instances.delete(this);
    this.logEvent('room_dispose');
  }

  /** Uniform random position inside the arena, away from the walls.
   *  Challenge rooms (daily/weekly) sample from their period-seeded LCG
   *  instead of Math.random() so layouts are reproducible for everyone
   *  playing that day/week. */
  randomPos() {
    const m = this.half - 1.5;
    const rand = this.isChallenge ? this._rng : Math.random;
    return { x: -m + rand() * m * 2, z: -m + rand() * m * 2 };
  }

  // -------------------------------------------------------------------------
  // Progression (Phase 4): XP, level-up, upgrade cards. The flow itself is
  // shared with LocalRoom in src/shared/sim/leveling.js — the methods below
  // are thin delegates kept for callers/tests (sr.grantXp, sr.hashSeed, ...).
  // -------------------------------------------------------------------------

  /** Grant `baseXp` to `sid`, respecting the Scholar bonus, then maybe level up. */
  grantXp(sid, baseXp) {
    leveling.grantXp(this.simLeveling, sid, baseXp);
  }

  /** While XP suffices for the next level, level up and roll 3 choices (or queue). */
  maybeLevelUp(sid) {
    leveling.maybeLevelUp(this.simLeveling, sid);
  }

  /** Pop the next queued level-up (if any) and show its cards. */
  showNextQueued(sid) {
    leveling.showNextQueued(this.simLeveling, sid);
  }

  hashSeed(sid, level) {
    return leveling.hashSeed(sid, level);
  }

  /** Apply `upgradeId` to the player behind `sid`, returns true if applied. */
  applyUpgrade(sid, upgradeId) {
    return leveling.applyUpgrade(this.simLeveling, sid, upgradeId);
  }

  /** Auto-pick deadline check: every tick. */
  checkAutoPicks() {
    leveling.checkAutoPicks(this.simLeveling);
  }

  /** Player picks one of their 3 pending upgrade cards. */
  onChooseUpgrade(client, msg = {}) {
    leveling.chooseUpgrade(this.simLeveling, client.sessionId,
      msg.choice ?? msg.id ?? '');
  }

  /** LOBBY -> COUNTDOWN. Scores/world were reset by the caller if needed. */
  startCountdown() {
    this.state.matchState = 'countdown';
    this.state.countdown = SERVER.match.countdownSeconds;
    this.logEvent('match_countdown', { seconds: SERVER.match.countdownSeconds });
  }

  /** COUNTDOWN -> PLAYING (the only place the GO transition happens). */
  startPlaying() {
    this.state.matchState = 'playing';
    this.state.countdown = 0;
    this.matchElapsed = 0;
    this.logEvent('match_start');
  }

  /** End the match: pick the winner, broadcast, freeze the simulation. */
  endMatch(winnerSid) {
    this.state.matchState = 'gameover';
    this.state.countdown = 0;
    // Guard: a timed match can end with no players left — never broadcast
    // a null winner id (schema expects a string).
    this.state.winnerId = winnerSid || '';
    const w = winnerSid ? this.state.players.get(winnerSid) : undefined;
    this.state.winnerName = w ? w.name : '';
    // CAREER STATS (PRD-career-stats.md): EVERY ending records — victory,
    // death, timed, daily finalize. Pending-overlay in persistence keeps
    // this safe against the daily blob's immediate re-read/merge.
    const careerRows = [];
    for (const [sid, player] of this.state.players) {
      const saved = loadPlayer(player.name) ?? {};
      const career = recordRun(saved.career ?? null, {
        wave: this.state.wave,
        score: player.score,
        victory: !!this.state.victory,
      });
      savePlayerDebounced(player.name, { ...saved, career });
      careerRows.push({ sid, name: player.name, career });
    }
    if (careerRows.length > 0) this.broadcast('careerUpdate', { rows: careerRows });
    this.logEvent('match_over', { winnerSid: this.state.winnerId, winnerName: this.state.winnerName });
  }

  /**
   * Daily Gauntlet finalize (daily rooms only, fires once): everyone died
   * simultaneously, so end the match through the normal endMatch path
   * (top score among the fallen wins the board), then write each player's
   * persisted daily record — WorldRoom's load/save pattern: read their
   * data/players/<name>.json, merge today's { date, bestScore, streak,
   * lastPlayed }, grant the streak XP reward through leveling.grantXp into
   * the live level/xp and persist debounced. Broadcasts 'dailyResult' with
   * one row per player.
   */
  finalizeDailyRun() {
    if (!this.isChallenge || this.state.matchState === 'gameover') return;
    // Weekly runs mirror this whole flow with a different persistence blob —
    // dispatched here so the daily body below stays byte-for-byte identical.
    if (this.mode === 'weekly') { this.finalizeWeeklyRun(); return; }
    let topSid = null;
    let best = -1;
    for (const [sid, p] of this.state.players) {
      if (p.score > best) { best = p.score; topSid = sid; }
    }
    this.endMatch(topSid);

    const today = utcDateStr();
    const results = [];
    for (const [sid, player] of this.state.players) {
      const saved = loadPlayer(player.name);
      const prev = saved?.daily ?? null;
      // Same-day re-run keeps the recorded streak unchanged (caller-owned,
      // per dailyRun contract); anything else goes through the shared math:
      // never played / gap -> 1, exact yesterday -> 2.
      const streak = (prev && prev.lastPlayed === today)
        ? Math.max(1, prev.streak ?? 1)
        : nextStreak(prev?.lastPlayed ?? null, today, prev?.streak ?? 0);
      const rewardXp = streakRewardXp(streak);
      // Grant into the LIVE player (Scholar-aware, may roll level-ups),
      // then persist live level/xp over the saved record like WorldRoom.
      leveling.grantXp(this.simLeveling, sid, rewardXp);
      savePlayerDebounced(player.name, {
        ...(saved ?? {}),
        name: player.name,
        character: player.character,
        level: player.level,
        xp: player.xp,
        score: player.score,
        upgrades: Object.fromEntries(player.upgrades.entries()),
        pendingChoices: [...player.pendingChoices],
        daily: {
          date: today,
          bestScore: Math.max(prev?.date === today ? (prev.bestScore ?? 0) : 0, player.score),
          streak,
          lastPlayed: today,
        },
      });
      results.push({ sid, name: player.name, score: player.score, streak, rewardXp });
    }
    this.broadcast('dailyResult', { results });
    this.logEvent('daily_finalize', { date: today, players: results.length });
  }

  /**
   * Weekly Gauntlet finalize (weekly rooms only, via finalizeDailyRun):
   * mirrors the daily flow — endMatch picks the top score among the fallen,
   * then each player's persisted weekly record merges through mergeWeekly
   * ({ week, bestScore, lastPlayed }; deliberately NO streak — forgiveness
   * is the mechanic) and XP pays out through the flat weeklyRewardXp ladder
   * into the live level/xp like the daily streak reward. Broadcasts the SAME
   * 'dailyResult' event name so clients reuse the banner path, tagged with
   * kind:'weekly'.
   */
  finalizeWeeklyRun() {
    let topSid = null;
    let best = -1;
    for (const [sid, p] of this.state.players) {
      if (p.score > best) { best = p.score; topSid = sid; }
    }
    this.endMatch(topSid);

    const week = utcWeekKey();
    const results = [];
    for (const [sid, player] of this.state.players) {
      const saved = loadPlayer(player.name);
      // Same-week keeps the max bestScore; a new week starts fresh.
      const merged = mergeWeekly(saved?.weekly ?? null, week, player.score);
      // Reward keys off the MERGED record: a re-run that didn't beat this
      // week's best still pays the ladder tier of that best score.
      const rewardXp = weeklyRewardXp(merged.bestScore);
      // Grant into the LIVE player (Scholar-aware, may roll level-ups),
      // then persist live level/xp over the saved record like WorldRoom.
      leveling.grantXp(this.simLeveling, sid, rewardXp);
      savePlayerDebounced(player.name, {
        ...(saved ?? {}),
        name: player.name,
        character: player.character,
        level: player.level,
        xp: player.xp,
        score: player.score,
        upgrades: Object.fromEntries(player.upgrades.entries()),
        pendingChoices: [...player.pendingChoices],
        weekly: merged,
      });
      results.push({
        sid, name: player.name, score: player.score,
        bestScore: merged.bestScore, rewardXp,
      });
    }
    this.broadcast('dailyResult', { results, kind: 'weekly' });
    this.logEvent('weekly_finalize', { week, players: results.length });
  }

  /** Reset the match in place (play again / auto-restart), keep room + players.
   *  World/scratch reset is shared (src/shared/sim/matchPhases.js, P1.3 slice
   *  4) — including clearing live projectiles like LocalRoom always did
   *  (sanctioned alignment #2); this method keeps only its own scratch maps,
   *  the timed-mode counter, the log and the countdown transition. */
  resetMatch() {
    matchPhases.resetMatchState(this.simPhases, {
      samplePos: () => this.randomPos(),
      onResetPlayerScratch: (sid) => {
        this.inputs.set(sid, { dirX: 0, dirZ: 0 });
        this.attackAt.set(sid, 0);
        this.skillAt.set(sid, 0);
        this.invulnUntil.set(sid, 0);
        this.animUntil.set(sid, 0);
      },
      onResetTransient: () => { this.pendingMelee = []; this.volatilePending.clear(); },
      onResetPowerUps: () => this.powerUpTimers.clear(),
    });
    resetAll(this.streaks); // fresh match = fresh streaks (PRD-kill-streaks.md)
    orbDrops.clearCharges(this.orbCharges); // fresh match = plain orbs
    this.shooterFireAt.clear(); // fresh match = synced volleys restart
    this.matchElapsed = 0;
    this.logEvent('match_reset');
    this.startCountdown();
  }

  /** "Play again": reset the match in place, keep the room + players. */
  onPlayAgain(client) {
    if (this.state.matchState !== 'gameover') return; // only after a match
    this.logEvent('match_play_again', { sid: client.sessionId });
    this.resetMatch();
  }

  /** Intermission shop: one free breather pick per player per intermission. */
  onChooseShop(client, msg = {}) {
    shopEffects.applyShopChoice(this.simShop, client.sessionId,
      msg.choice ?? msg.id ?? '');
  }

  startNextWave() {
    if (this.state.matchState !== 'intermission') return;
    const next = this.state.wave + 1;
    // WAVE FINALE (PRD-wave-finale.md): advancing past the finale wave is a
    // co-op win — the run ends instead of spawning another wave.
    if (SERVER.wave.finaleWave > 0 && next > SERVER.wave.finaleWave) {
      this.state.victory = true;
      this.logEvent('match_victory', { waves: this.state.wave });
      // Challenge runs (daily/weekly): a WON gauntlet is a completed run —
      // finalize FIRST (it ends the match itself); calling endMatch directly
      // would freeze state into gameover and finalize's own guard would
      // skip streak/blob recording entirely.
      if (this.isChallenge) this.finalizeDailyRun();
      else this.endMatch('');
      return;
    }
    this.pendingMelee = [];
    this.intermissionShopChoices.clear();
    this.state.projectiles.clear();
    this.spawnWave(next);
    this.intermissionBox.until = 0;
    this.state.intermissionUntil = 0;
    this.startCountdown();
  }

  /** Click on the wave-cleared popup: spawn the next wave + countdown. */
  onNextWave(client) {
    if (this.state.matchState !== 'intermission') return; // popup-gated
    this.logEvent('wave_next', { sid: client.sessionId, wave: this.state.wave + 1 });
    this.startNextWave();
  }

  /**
   * Client input intent: a unit direction plus an edge-triggered attack.
   * Position is NOT taken from the client — only the direction, which we
   * validate (finite, magnitude <= 1) so a hostile client cannot move
   * faster than the server speed limit.
   */
  onInput(client, msg = {}) {
    const sid = client.sessionId;

    // Anti-cheat: cap input message rate, drop the excess with a warning.
    const now = Date.now();
    const times = this.msgTimes.get(sid) || [];
    times.push(now);
    while (times.length && times[0] < now - 1000) times.shift();
    if (times.length > SERVER.net.maxInputPerSecond) {
      this.warnEvent('input_dropped_rate', { sid, perSecond: SERVER.net.maxInputPerSecond });
      return;
    }
    GameRoom.stats.inputTimes.push(now);

    // GHOST PLAYERS: a dead player can only click respawn — all movement,
    // attack and pickup intents are ignored.
    const player = this.state.players.get(sid);
    if (!player || player.hp <= 0) {
      this.warnEvent('input_rejected_dead', { sid });
      return;
    }

    // Validate movement delta: non-finite or oversized values are dropped
    // (basic anti-cheat — the server integrates with its own speed anyway).
    let dirX = Number(msg.dirX);
    let dirZ = Number(msg.dirZ);
    if (!Number.isFinite(dirX) || !Number.isFinite(dirZ)) { dirX = 0; dirZ = 0; }
    const len = Math.hypot(dirX, dirZ);
    if (len > 1) { dirX /= len; dirZ /= len; } // clamp diagonal input

    // L (hold) = block: the player strafes at reduced speed while guarding.
    // Direction is no longer zeroed — blockSpeedMult is applied in movePlayers.
    const blocking = !!msg.block;
    player.blocking = blocking;
    const moving = dirX !== 0 || dirZ !== 0;
    this.inputs.set(sid, { dirX, dirZ });

    // Attack: only valid while the match is PLAYING (no swinging during the
    // countdown or on the game-over screen), server-enforced cooldown — and
    // CANNOT be started while blocking (combat rule: drop the guard to swing).
    // Attacks ARE allowed while moving (player choice).
    if (msg.attack) {
      const reject = (reason, extra = {}) =>
        this.warnEvent('input_attack_rejected', { sid, reason, ...extra });
      if (this.state.matchState !== 'playing') {
        reject(`match_${this.state.matchState}`);
      } else if (now < this.attackAt.get(sid)) {
        reject('cooldown', { cooldownMs: this.attackAt.get(sid) - now });
      } else if (blocking) {
        reject('blocking');
      } else {
        const cdMs = SERVER.player.attackCooldownMs * effectiveAttackCdMult(player.upgrades);
        this.attackAt.set(sid, now + cdMs);
        this.animUntil.set(sid, now + SERVER.player.attackAnimMs);
        player.anim = 'attack'; // movePlayers preserves this during animUntil
        // IMPACT ALIGNMENT: the swing starts now but the damage lands at
        // ~40% into the arc (attackImpactMs), where the blade visually
        // connects — resolved in updatePlaying() when the impact comes due.
        // Cooldown/anim apply immediately so the HUD + animation match the
        // swing the player sees.
        const atk = attackFor(player.character);
        if (atk.kind === 'projectile') {
          this.spawnProjectile(sid, player, atk);
        } else {
          this.pendingMelee.push({ sid, at: now + SERVER.player.attackImpactMs });
        }
      }
    }

    // Skill cast (K): same gating as the melee (incl. no cast while blocking);
    // the cooldown + cast window come from the caster's per-character skill def
    // (src/shared/skills.js). Casts work while moving.
    if (msg.skill) {
      const reject = (reason) =>
        this.warnEvent('input_skill_rejected', { sid, reason });
      if (this.state.matchState !== 'playing') {
        reject(`match_${this.state.matchState}`);
      } else if (now < this.skillAt.get(sid)) {
        reject('cooldown');
      } else if (blocking) {
        reject('blocking');
      } else {
        this.castSkill(sid);
      }
    }
  }

  /** HP <= 0 during a match -> click to respawn (never during gameover). */
  onRespawn(client) {
    const player = this.state.players.get(client.sessionId);
    if (!player || player.hp > 0) return;
    if (this.state.matchState === 'gameover') return;
    const p = this.randomPos();
    player.x = p.x;
    player.z = p.z;
    player.hp = effectiveMaxHp(player.character, player.upgrades);
    player.anim = 'idle';
    player.blocking = false;
    player.attackCd = 0;
    player.skillCd = 0;
    player.effects.clear(); // RESPAWN LEAK: buffs die with the player
    this.inputs.set(client.sessionId, { dirX: 0, dirZ: 0 });
    this.attackAt.set(client.sessionId, 0);
    this.skillAt.set(client.sessionId, 0);
    this.animUntil.set(client.sessionId, 0);
    this.invulnUntil.set(client.sessionId, Date.now() + 1000); // spawn grace
    this.logEvent('player_respawn', { sid: client.sessionId });
  }

  /**
   * True when `player` is guarding (L held) AND the hit source at (ax, az)
   * lies inside the frontal block arc: the attacker must be in front of the
   * blocker. A successful block negates the hit entirely — no HP loss, no
   * knockback, nothing consumed.
   */
  isBlocked(player, ax, az) {
    return blockedHit(player, ax, az, SERVER.player.blockArcCos);
  }

  /** Tell the victim's client its guard held (clang + "BLOCKED" text). */
  notifyBlocked(sid, victim) {
    const client = this.clients.find((c) => c.sessionId === sid);
    client?.send('blocked', { x: victim.x, z: victim.z });
    this.logEvent('player_blocked', { sid });
  }

  /**
   * Apply one hit of `amount` damage to `victim` (sessionId `sid`), coming
   * from (srcX, srcZ). Resolution order: still-invulnerable -> ignored;
   * block success -> NO damage (requirement: "if block success the health
   * will not lose"); SHIELD power-up -> absorbs + consumed; otherwise HP
   * drops, invulnerability window opens and the victim is knocked back.
   * @returns true when HP was actually lost.
   */
  damagePlayer(sid, victim, amount, srcX, srcZ) {
    const now = Date.now();
    if (now < this.invulnUntil.get(sid)) return false;
    // INTERMISSION: between waves every player is invulnerable — hits are
    // ignored entirely (no HP loss, no knockback, no block feedback) until
    // the next wave starts.
    if (this.state.matchState !== 'playing') return false;
    if (this.isBlocked(victim, srcX, srcZ)) {
      this.notifyBlocked(sid, victim);
      return false;
    }
    if (victim.effects.has('shield')) {
      victim.effects.delete('shield'); // blocks exactly one hit, then consumed
      this.logEvent('shield_absorb', { sid });
      return false;
    }
    this.invulnUntil.set(sid, now + SERVER.player.invulnMs);
    const died = strikePlayer(victim, amount, srcX, srcZ,
      SERVER.player.knockback * 0.15, this.half);
    // Kill-streaks (PRD-kill-streaks.md): dying drops the victim's streak.
    if (died) resetSid(this.streaks, sid);
    // Hit react: brief 'hit' anim override (300ms) so all clients see the
    // victim flinch — mirrors the enemy hit-stun pattern.
    victim.anim = 'hit';
    this.animUntil.set(sid, now + 300);
    return true;
  }

  /**
   * Kill-streak bookkeeping (PRD-kill-streaks.md): called after EVERY enemy
   * death credited to `sid` — melee/projectile/skill kills through hitEnemy,
   * the bash strike path in castSkill. Announces ONLY at MILESTONES counts
   * (everything else stays silent) as 'killStreak' { sid, name, count, label }
   * with the POST-increment count. `now` is injectable so tests can control
   * window timing; LocalRoom._creditStreak mirrors this byte-for-byte.
   */
  creditStreak(sid, now = Date.now()) {
    const ms = registerKill(this.streaks, sid, now);
    if (!ms) return;
    this.broadcast('killStreak', {
      sid,
      name: this.state.players.get(sid)?.name ?? '',
      count: this.streaks.get(sid)?.count ?? 0,
      label: ms,
    });
  }

  /**
   * Apply one hit of `damage` to a LIVING enemy from (srcX, srcZ): HIT-STUN
   * (the enemy stops chasing/attacking for hitStunMs and plays the hit
   * react), a small knockback away from the attacker, and — on kill —
   * the enemy STAYS DEAD (no respawn) and the killer scores. Thin delegate
   * over shared/sim/combatBook.resolveEnemyHit (P1.3 slice 2), which is
   * SID-BASED: live call paths pass the killer's session id so no reverse
   * object lookup ever runs. The PlayerState fallback exists only for legacy
   * test callers that hand us the player object directly.
   * @returns true when the hit killed the enemy.
   */
  hitEnemy(enemy, damage, srcX, srcZ, killer) {
    const killerSid = typeof killer === 'string'
      ? killer
      : (killer
        ? [...this.state.players.entries()].find(([, p]) => p === killer)?.[0]
        : null);
    const res = combatBook.resolveEnemyHit(
      this.simCombat, enemy, damage, srcX, srcZ, killerSid ?? null);
    if (res.killed && killerSid != null) this.creditStreak(killerSid);
    return res.killed;
  }

  /**
   * Melee swing from one player: damage every enemy in range + in front,
   * and every OTHER player in range + in front (PvP — the block mechanic
   * guards against both). Called when the swing's impact comes due
   * (attackImpactMs after the J press), so the damage lands when the blade
   * is visually mid-arc.
   */
  melee(sid) {
    const player = this.state.players.get(sid);
    if (!player || player.hp <= 0) return; // ghosts cannot swing
    player.anim = 'attack'; // movePlayers preserves this during animUntil
    const cfg = SERVER.player;
    const stats = statsOf(player); // Phase 3: per-class melee numbers
    const dmg = effectiveMeleeDamage(player.character, player.upgrades);
    const pvpDmg = stats.meleePvpDamage ?? cfg.attackPvpDamage;
    // Shared arc math: which enemies (and players) this swing covers.
    for (const i of meleeHits(player, [...this.state.enemies], cfg)) {
      const enemy = this.state.enemies[i];
      this.hitEnemy(enemy, dmg, player.x, player.z, sid);
    }
    // PvP: same swing also hurts other living players in the arc.
    for (const [osid, victim] of this.state.players) {
      if (osid === sid || victim.hp <= 0) continue;
      if (meleeHits(player, [victim], cfg).length) {
        this.damagePlayer(osid, victim, pvpDmg, player.x, player.z);
      }
    }
  }

  /**
   * Per-character skill cast (K). Every class shares the J melee but casts its
   * own skill (src/shared/skills.js) — distinct shape/damage/cooldown. The
   * cast CANNOT be started while moving or blocking; the animation overrides
   * to 'skill' for animUntil. Skills damage enemies AND other players (PvP),
   * subject to the victim's block; killed enemies respawn.
   */
  castSkill(sid) {
    const state = this.state;
    const player = state.players.get(sid);
    if (!player || player.hp <= 0) return;
    const baseDef = skillFor(player.character);
    // Phase 4: skill-specific upgrades (damage, count, stun)
    const def = effectiveSkill(baseDef, player.upgrades);
    const now = Date.now();
    if (now < this.skillAt.get(sid)) return; // belt + braces (onInput gates too)
    const skillCd = def.cooldownMs * effectiveSkillCdMult(player.upgrades);
    this.skillAt.set(sid, now + skillCd);
    this.animUntil.set(sid, now + def.animMs); // anim='skill' window
    player.anim = 'skill'; // movePlayers preserves this during animUntil

    // Phase 3: resolveSkillHits returns { hits, projectiles?, movement?, damagePerHit? }
    const targets = [...state.enemies].map((e) => ({ x: e.x, z: e.z }));
    const result = resolveSkillHits(def, player, targets);

    // PvP hits are resolved BEFORE the bash dash moves the caster —
    // re-resolving afterwards would compute a SECOND dash from the new
    // position and mis-place the hit cone.
    const stats = classStats(player.character);
    const skillPvpDmg = stats.skillPvpDamage || 10;
    const pvpVictims = [];
    for (const [osid, victim] of state.players) {
      if (osid === sid || victim.hp <= 0) continue;
      const pResult = resolveSkillHits(def, player, [{ x: victim.x, z: victim.z }]);
      if (pResult.hits.length) pvpVictims.push(osid);
    }

    // Bash: move the caster to the landing position
    if (result.movement) {
      const half = SERVER.world.size / 2;
      const nx = Math.max(-half, Math.min(half, player.x + result.movement.dx));
      const nz = Math.max(-half, Math.min(half, player.z + result.movement.dz));
      player.x = nx;
      player.z = nz;
    }

    // Direct hits (bash, chainlight, legacy aoe/cone). Bash carries its own
    // knockback + 1s stun — the signature "cone knockback + stun" — instead
    // of the standard 450ms hit-stun hitEnemy applies.
    if (result.hits.length > 0) {
      for (const i of result.hits) {
        const enemy = state.enemies[i];
        if (!enemy) continue;
        const dmg = result.damagePerHit ? result.damagePerHit[result.hits.indexOf(i)] : def.damage;
        if (def.kind === 'bash') {
          // Bulwark (knockbackImmune): takes the damage + stun, never the shove.
          const { hit, killed } = strikeEnemy(enemy, dmg, player.x, player.z,
            combatBook.knockbackAgainst(enemy, def.knockback), this.half);
          if (hit) {
            if (killed) {
              player.score += SERVER.enemy.killScore;
              this.grantXp(sid, SERVER.progression?.xpPerKill ?? 30);
              combatBook.onEliteKill(this.simCombat, enemy, sid); // elite burst + Volatile fuse
              this.creditStreak(sid); // bash kills feed streaks like every other kill
              this.logEvent('enemy_killed', { wave: state.wave, by: player.name });
            } else {
              enemy.anim = 'hit';
              this.enemyAnimUntil.set(enemy, now + SERVER.enemy.hitAnimMs);
              this.enemyStunUntil.set(enemy, now + (def.stunDurationMs || 1000));
            }
          }
        } else {
          this.hitEnemy(enemy, dmg, player.x, player.z, sid);
        }
      }
    }

    // Projectile-spawning skills (multishot, firewave)
    if (result.projectiles) {
      for (const pDef of result.projectiles) {
        const proj = new ProjectileState(
          this._projectileId++, sid, pDef.projKind,
          player.x, player.z, pDef.dirX, pDef.dirZ
        );
        proj.speed = pDef.speed;
        proj.damage = pDef.damage;
        proj.ttl = pDef.ttlMs;
        proj.ownerIsPlayer = true;
        this.state.projectiles.push(proj);
        // Firewave burn DoT: track per-projectile so the hit handler can apply it
        if (pDef.effects && pDef.effects.burn) {
          combatBook.registerProjBurn(this.simCombat, proj.id, pDef.effects.burn);
        }
      }
    }

    // PvP: apply the pre-resolved victim list (per-class damage).
    for (const osid of pvpVictims) {
      const victim = state.players.get(osid);
      if (victim) this.damagePlayer(osid, victim, skillPvpDmg, player.x, player.z);
    }
    this.logEvent('skill_cast', { sid, character: player.character, skill: def.key });
  }

  /**
   * Spawn a projectile from `player`'s current position in the facing direction.
   * The projectile is authoritative (server steps it each tick) and added to
   * WorldState.projectiles so every client sees it via Colyseus patches.
   */
  spawnProjectile(sid, player, atkDef) {
    const { fx, fz } = { fx: Math.sin(player.rotY), fz: Math.cos(player.rotY) };
    const proj = new ProjectileState(
      this._projectileId++,
      sid,
      atkDef.projKind,
      player.x,
      player.z,
      fx,
      fz
    );
    proj.speed = atkDef.speed;
    // Phase 4: sharpshooter stacks boost projectile damage
    const effDmg = (atkDef.kind === 'projectile')
      ? effectiveRangedDamage(player.character, player.upgrades)
      : atkDef.damage;
    proj.damage = effDmg;
    proj.ttl = atkDef.ttlMs;
    proj.ownerIsPlayer = true;
    this.state.projectiles.push(proj);
  }

  /**
   * Tick every live projectile: step forward, check collision with enemies and
   * other players (PvP), remove on hit or TTL/bounds expiry. Called from
   * updatePlaying() each fixed timestep. Delegates to the shared D6 loop
   * (src/shared/sim/projectileLoop.js, P1.3 slice 3); hit resolution stays
   * room-side via the simProjectiles hooks.
   */
  updateProjectiles(dt) {
    projectileLoop.stepProjectiles(this.simProjectiles, dt);
  }

  /** One fixed timestep of the simulation, dispatched by match phase. */
  update(dt) {
    const state = this.state;

    // Empty-room cleanup: dispose rooms with no players after the TTL so
    // abandoned rooms (including stale gameover ones) cannot pile up.
    if (state.players.size === 0) {
      const idleMs = Date.now() - this.lastActiveAt;
      if (idleMs > SERVER.match.emptyRoomTtlMs) {
        this.logEvent('room_empty_dispose', { idleMs });
        this.disconnect();
        return;
      }
    } else {
      this.lastActiveAt = Date.now();
    }

    // Phase 4: auto-pick stalled upgrade cards — must run before pause wall so
    // the 10s deadline actually fires (pausing the sim must NOT stall the pick).
    // D7 pause wall (src/shared/sim/matchPhases.js, P1.3 slice 4): the shared
    // gate scans pending cards across players, arms/caps the global wall by
    // maxPauseMs and extends an active intermission deadline while walled.
    const { dtEff } = matchPhases.pauseGate(this.simPhases, dt);

    // Paused (or a zero-dt tick): skip the world step — the gate already ran
    // checkWinConditions(0) on walled ticks so score-triggered wins aren't
    // deadlocked behind a pending upgrade card (phase4.test block 8 grants
    // XP->pending then scores to win).
    if (dtEff === 0) return;
    switch (state.matchState) {
      case 'lobby':
        // Free movement so players can warm up; no pickups, no enemies.
        this.movePlayers(dtEff);
        this.setEnemiesIdle();
        return;
      case 'countdown':
        // Frozen world; tick the 3-2-1-GO display down to zero.
        state.countdown = Math.max(0, state.countdown - dtEff);
        if (state.countdown <= 0) this.startPlaying();
        return;
      case 'playing':
        this.updatePlaying(dtEff);
        return;
      case 'intermission':
        // Wave cleared: free movement + pickups, NO enemies (all dead), and
        // everyone is invulnerable (damagePlayer gates on 'playing').
        // Auto-advances after intermissionMs (shop/choices pause the clock
        // above); 'nextWave' click still skips the wait.
        this.movePlayers(dtEff);
        this.updateEffects(dtEff * 1000);
        this.updatePickups(dtEff);
        // A Volatile fuse armed on the wave's last kill still burns down here;
        // the AoE itself is a no-op while intermission invulnerability holds.
        combatBook.tickVolatile(this.simCombat, Date.now());
        this.checkWinConditions(dtEff);
        if (Date.now() >= this.intermissionBox.until) this.startNextWave();
        return;
      case 'gameover':
        return; // frozen; only 'playAgain' moves on
    }
  }

  /** Move players only (used during lobby and playing). */
  movePlayers(dt) {
    const now = Date.now();
    for (const [sid, player] of this.state.players) {
      // GHOST PLAYERS: corpses are frozen — no movement, no anim, no cooldown.
      if (player.hp <= 0) {
        player.anim = 'idle';
        player.blocking = false;
        player.attackCd = 0;
        player.skillCd = 0;
        continue;
      }
      const intent = this.inputs.get(sid);
      const dirX = intent.dirX;
      const dirZ = intent.dirZ;
      const speed = (statsOf(player).speed ?? SERVER.player.speed) *
        effectiveSpeedMult(player.upgrades) *
        (player.blocking ? SERVER.player.blockSpeedMult : 1) *
        (player.effects.has('speed') ? SERVER.powerUps.speed.multiplier : 1);
      // RC7: attacking/casting NEVER blocks movement — a player can move and
      // attack at the same time. stepPlayer always integrates; the swing/cast
      // only overrides the ANIMATION below, not the position. (Rooting the
      // caster here is what previously froze move+attack.)
      const stepped = stepPlayer(player.x, player.z, player.rotY,
        dirX, dirZ, speed, dt, this.half);
      player.x = stepped.x;
      player.z = stepped.z;
      player.rotY = stepped.rotY;
      // While the swing/cast override is active keep the anim melee/castSkill
      // set ('attack'/'skill'), even while moving; otherwise drive from motion.
      if (now >= this.animUntil.get(sid)) {
        player.anim = (dirX || dirZ) ? 'run' : 'idle';
      }
      // Broadcast the cooldowns for the HUD bars (0 = ready).
      player.attackCd = Math.max(0, this.attackAt.get(sid) - now);
      player.skillCd = Math.max(0, this.skillAt.get(sid) - now);
    }
  }

  /** Enemies stand still (lobby / gameover) — purely cosmetic. */
  setEnemiesIdle() {
    for (const enemy of this.state.enemies) enemy.anim = 'idle';
  }

  /** The whole playing-phase simulation. */
  updatePlaying(dt) {
    const now = Date.now();
    const state = this.state;

    // --- Scheduled melee impacts ---------------------------------------
    // J pressed -> swing anim starts immediately, but the DAMAGE lands
    // attackImpactMs later (mid-arc, where the blade visually connects).
    // Positions are sampled at impact time, so stepping out of the arc in
    // time genuinely avoids the hit.
    for (let i = this.pendingMelee.length - 1; i >= 0; i--) {
      if (now >= this.pendingMelee[i].at) {
        const { sid } = this.pendingMelee.splice(i, 1)[0];
        this.melee(sid);
      }
    }

    this.movePlayers(dt);
    this.updateEffects(dt * 1000);
    this.updatePickups(dt);
    this.updateProjectiles(dt);

    // Elite affixes: drain due Volatile fuses (AoE through damagePlayer, then
    // corpse release). Checked every playing tick like any other timer.
    combatBook.tickVolatile(this.simCombat, now);

    // --- Enemies: chase the nearest LIVING player, hurt on contact -------
    let alive = 0;
    for (const enemy of state.enemies) {
      if (enemy.hp <= 0) continue; // dead stays dead until the next wave
      alive++;
      // 'hit'/'attack' anim overrides outlive the tick that set them;
      // while one is active the movement anim may not overwrite it.
      const animOverride = now < (this.enemyAnimUntil.get(enemy) || 0);
      if (!animOverride) this.enemyAnimUntil.delete(enemy);

      // HIT-STUN: a struck enemy stops acting — no chase, no contact
      // damage — until the stun expires. This is the "enemies stop their
      // actions when hit" rule, enforced server-side.
      if (now < (this.enemyStunUntil.get(enemy) || 0)) {
        enemy.anim = 'hit';
        continue;
      }
      this.enemyStunUntil.delete(enemy);

      let targetSid = null;   // sessionId of the nearest living player
      let target = null;
      let best = Infinity;
      for (const [sid, player] of state.players) {
        if (player.hp <= 0) continue; // corpses are not targets
        const dx = enemy.x - player.x;
        const dz = enemy.z - player.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; target = player; targetSid = sid; }
      }

      if (target) {
        const dist = Math.sqrt(best);
        enemy.rotY = Math.atan2(target.x - enemy.x, target.z - enemy.z);
        const archEntry = enemy.archetype ? archetypeByName(enemy.archetype) : null;
        if (archEntry?.name === 'Shooter') {
          // Ranged pursuit: close beyond preferred range, kite when crowded,
          // otherwise hold and fire on the shared cooldown (parity: LocalRoom
          // mirrors byte-for-byte).
          const spdBase = SERVER.enemy.speed * this.enemySpeedMul *
            (enemy.elite ? affixByName(enemy.elite)?.speedMul ?? 1 : 1) *
            archEntry.speedMul;
          const dxn = (target.x - enemy.x) / dist;
          const dzn = (target.z - enemy.z) / dist;
          let moved = false;
          if (dist > SHOOTER_PREFERRED_RANGE) {
            enemy.x += dxn * spdBase * dt;
            enemy.z += dzn * spdBase * dt;
            moved = true;
          } else if (dist < SHOOTER_KITE_RANGE) {
            enemy.x -= dxn * spdBase * SHOOTER_KITE_SPEED_MUL * dt;
            enemy.z -= dzn * spdBase * SHOOTER_KITE_SPEED_MUL * dt;
            moved = true;
          }
          enemy.x = Math.max(-this.half, Math.min(this.half, enemy.x));
          enemy.z = Math.max(-this.half, Math.min(this.half, enemy.z));
          if (!moved && !animOverride) enemy.anim = 'idle';
          else if (moved && !animOverride) enemy.anim = 'run';
          let vol = this.shooterFireAt.get(enemy);
          if (!vol) vol = { at: now + SHOOTER_FIRE_COOLDOWN_MS, told: false };
          if (dist <= SHOOTER_PREFERRED_RANGE + 1) {
            // WINDUP TELEGRAPH (research lesson #11): attack anim shows
            // WINDUP_MS before the volley so deaths are legible.
            if (!vol.told && now >= vol.at - SHOOTER_WINDUP_MS) {
              vol.told = true;
              if (!animOverride) enemy.anim = 'attack';
              this.enemyAnimUntil.set(enemy, now + SHOOTER_WINDUP_MS);
            }
            if (now >= vol.at) {
              const proj = new ProjectileState(this._projectileId++, '', 'arrow',
                enemy.x, enemy.z, dxn, dzn);
              proj.speed = SERVER.projectile.arrowSpeed;
              proj.damage = SERVER.enemy.shotDamage;
              proj.ttl = SERVER.projectile.arrowTtlMs;
              proj.ownerIsPlayer = false;
              this.state.projectiles.push(proj);
              this.enemyAnimUntil.set(enemy, now + SERVER.enemy.attackAnimMs);
              enemy.anim = 'attack';
              vol = { at: now + SHOOTER_FIRE_COOLDOWN_MS, told: false };
            }
          }
          this.shooterFireAt.set(enemy, vol);
        } else if (dist > SERVER.enemy.contactRange) {
          // Chase: step toward the target, staying server-authoritative.
          // Daily rooms multiply by today's enemySpeedMul (1 in waves mode);
          // elite affixes add their own speedMul (Swift +60%, shared/sim/elites.js).
          const spd = SERVER.enemy.speed * this.enemySpeedMul *
            (enemy.elite ? affixByName(enemy.elite)?.speedMul ?? 1 : 1) *
            (enemy.archetype ? archetypeByName(enemy.archetype)?.speedMul ?? 1 : 1);
          enemy.x += (target.x - enemy.x) / dist * spd * dt;
          enemy.z += (target.z - enemy.z) / dist * spd * dt;
          if (!animOverride) enemy.anim = 'run';
        } else if (now >= this.invulnUntil.get(targetSid)) {
          // Contact damage, resolved through damagePlayer: a successful BLOCK
          // (guarding + enemy in front) negates it, the SHIELD power-up
          // absorbs one hit, otherwise the target takes damage + knockback.
          this.enemyAnimUntil.set(enemy, now + SERVER.enemy.attackAnimMs);
          enemy.anim = 'attack'; // punch (swings even when blocked)
          const victimHp = target.hp;
          if (this.damagePlayer(targetSid, target, SERVER.enemy.contactDamage, enemy.x, enemy.z)) {
            // Vampiric elites siphon back a share of the HP they drained.
            combatBook.applyVampiricHeal(this.simCombat, enemy, victimHp - target.hp);
          }
        } else if (!animOverride) {
          enemy.anim = 'idle'; // adjacent but the player is invulnerable
        }
      } else if (!animOverride) {
        enemy.anim = 'idle';
      }
    }

    // --- CHALLENGE RUN END (daily/weekly rooms only) ---------------------
    // Every connected player dead SIMULTANEOUSLY -> the run is over: end the
    // match through the normal endMatch path, then finalize each player's
    // persisted daily/weekly record. Checked before the wave-clear gate so a
    // simultaneous wipe is never mistaken for an intermission.
    if (this.isChallenge && state.players.size > 0 &&
        [...state.players.values()].every((p) => p.hp <= 0)) {
      this.finalizeDailyRun();
      return;
    }

    // --- Wave cleared: every enemy dead -> intermission ------------------
    // Intermission shows wave clear + shop (PVE pause), then auto-advances.
    if (state.enemies.length > 0 && alive === 0) {
      state.matchState = 'intermission';
      this.pendingMelee = [];
      this.intermissionBox.until = Date.now() + (SERVER.wave?.intermissionMs ?? 8000);
      this.state.intermissionUntil = this.intermissionBox.until;
      this.intermissionShopChoices.clear();
      this.logEvent('wave_cleared', { wave: state.wave });
      return;
    }

    this.checkWinConditions(dt);
  }

  /** Orb + power-up pickups (shared by 'playing' and 'intermission'). */
  updatePickups(dt) {
    const state = this.state;
    // --- Magnet: living holders drift nearby orbs toward themselves first,
    // so pulled orbs can enter pickup radius and pay on this very tick.
    const magnetHolders = [];
    for (const pl of state.players.values()) {
      if (pl.hp > 0 && pl.effects.has('magnet')) magnetHolders.push(pl);
    }
    if (magnetHolders.length > 0) {
      const mc = SERVER.powerUps.magnet;
      pullOrbs(state.orbs, magnetHolders, mc.pullRadius, mc.pullSpeed, dt);
    }
    // --- Orbs: first LIVING player within radius collects (server decides)
    const orbScore = (player) =>
      SERVER.orb.score * (player.effects.has('double') ? SERVER.powerUps.double.multiplier : 1);
    for (const orb of state.orbs) {
      for (const [sid, player] of state.players) {
        if (player.hp <= 0) continue; // corpses cannot collect
        const radius = SERVER.orb.radius * effectivePickupMult(player.upgrades);
        const dx = orb.x - player.x;
        const dz = orb.z - player.z;
        if (dx * dx + dz * dz < radius * radius) {
          player.score += orbScore(player);
          this.grantXp(sid, SERVER.progression?.xpPerOrb ?? 20);
          // Charged kill-orbs pay their stored XP on top, then revert
          // (PRD-orb-drops.md) — order matters: drain BEFORE the teleport.
          const charge = orbDrops.drainCharge(this.orbCharges, orb);
          if (charge > 0) this.grantXp(sid, charge);
          const p = this.randomPos();
          orb.x = p.x;
          orb.z = p.z;
          break; // one player per orb per tick
        }
      }
    }

    // --- Power-ups: pickup applies the timed effect, then respawns -------
    for (const pu of state.powerUps) {
      if (!pu.active) {
        const left = (this.powerUpTimers.get(pu) ?? 0) - dt;
        if (left > 0) {
          this.powerUpTimers.set(pu, left);
          continue;
        }
        this.powerUpTimers.delete(pu);
        const p = this.randomPos();
        pu.x = p.x;
        pu.z = p.z;
        pu.active = true;
        continue;
      }
      const cfg = SERVER.powerUps[pu.type];
      for (const player of state.players.values()) {
        if (player.hp <= 0) continue; // corpses cannot collect
        const radius = SERVER.powerUps.radius * effectivePickupMult(player.upgrades);
        const dx = pu.x - player.x;
        const dz = pu.z - player.z;
        if (dx * dx + dz * dz < radius * radius) {
          player.effects.set(pu.type, cfg.durationMs); // replace timer on re-pickup
          pu.active = false;
          this.powerUpTimers.set(pu, SERVER.powerUps.respawnSeconds);
          this.logEvent('player_pickup', { name: player.name, type: pu.type });
          break;
        }
      }
    }
  }

  /** Score/duration win conditions (living players only — corpses cannot win). */
  checkWinConditions(dt) {
    const state = this.state;
    if (SERVER.match.targetScore > 0) {
      for (const [sid, player] of state.players) {
        if (player.hp <= 0) continue;
        if (player.score >= SERVER.match.targetScore) {
          this.endMatch(sid);
          return;
        }
      }
    }
    if (SERVER.match.matchDurationSeconds > 0) {
      this.matchElapsed += dt;
      if (this.matchElapsed >= SERVER.match.matchDurationSeconds) {
        let winnerSid = null;
        let bestScore = -1;
        for (const [sid, player] of state.players) {
          if (player.hp <= 0) continue;
          if (player.score > bestScore) { bestScore = player.score; winnerSid = sid; }
        }
        // endMatch(null) is guarded: timed matches can end with no living
        // players (or none at all) — winnerId/winnerName stay empty.
        this.endMatch(winnerSid);
      }
    }
  }

  /** Tick power-up timers down; remove expired effects. */
  updateEffects(msec) {
    for (const player of this.state.players.values()) {
      const expired = [];
      for (const [name, ms] of player.effects) {
        const left = ms - msec;
        if (left <= 0) expired.push(name);
        else player.effects.set(name, left);
      }
      for (const name of expired) player.effects.delete(name);
    }
    // Burn DoT: tick damage on burning enemies (shared/sim/combatBook.js —
    // runs for the whole room regardless of any player's HP, as before).
    combatBook.tickBurns(this.simCombat, Date.now());
  }
}
