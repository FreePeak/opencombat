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
import { WorldState, PlayerState, OrbState, PowerUpState, EnemyState } from '../schema/StateSchema.js';
import { SERVER } from '../config.js';
import { log, warn } from '../log.js';
import { takeToken, normalizeIp } from '../ratelimit.js';
import { stepPlayer } from '../movement.js';
import { skillFor, resolveSkillHits } from '../../shared/skills.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Simple string hash: same name -> same color, stable across joins.
function nameHash(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

export default class GameRoom extends Room {
  // Hard cap so one room cannot be overloaded (README "Design decisions").
  maxClients = SERVER.match.maxClients;

  // Live-room registry + observability stats, shared with /healthz + /metrics
  // and used by the headless test suite to reach authoritative server state.
  static instances = new Set();
  static stats = { lastTickMs: 0, inputTimes: [] };

  onCreate() {
    GameRoom.instances.add(this);
    // Empty-room cleanup is ours (configurable TTL, documented in README);
    // disable Colyseus' 1s auto-dispose so a gameover room survives for
    // latecomers and the matchmaker reuse logic stays deterministic.
    this.autoDispose = false;

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
    this.powerUpTimers = new Map(); // powerUp -> seconds until it respawns

    this.half = SERVER.world.size / 2; // arena half-extent on X and Z
    this.matchElapsed = 0;          // seconds into the playing phase (timed mode)
    this.lastActiveAt = Date.now(); // empty-room TTL anchor

    this.spawnOrbs();
    this.spawnEnemies();
    this.spawnPowerUps();

    // --- Messages -------------------------------------------------------
    this.onMessage('input', (client, msg) => this.onInput(client, msg));
    this.onMessage('respawn', (client) => this.onRespawn(client));
    this.onMessage('playAgain', (client) => this.onPlayAgain(client));

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

  spawnEnemies() {
    for (let i = 0; i < SERVER.enemy.count; i++) {
      const p = this.randomPos();
      this.state.enemies.push(new EnemyState(p.x, p.z));
    }
  }

  spawnPowerUps() {
    // One of each type, so all three are always in play.
    const types = Object.keys(SERVER.powerUps).filter((k) =>
      ['speed', 'shield', 'double'].includes(k));
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
      player.color = SERVER.colors[nameHash(name) % SERVER.colors.length];
      this.state.players.set(client.sessionId, player);
      this.logEvent('player_join', { sid: client.sessionId, name, players: this.state.players.size });
    }

    this.inputs.set(client.sessionId, { dirX: 0, dirZ: 0 });
    this.attackAt.set(client.sessionId, 0);
    this.skillAt.set(client.sessionId, 0);
    this.invulnUntil.set(client.sessionId, 0);
    this.animUntil.set(client.sessionId, 0);
    this.msgTimes.set(client.sessionId, []);
    clearTimeout(this.graceTimers.get(client.sessionId));
    this.graceTimers.delete(client.sessionId);

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
    const t = this.graceTimers.get(sid);
    if (t) { clearTimeout(t); this.graceTimers.delete(sid); }
    this.logEvent('player_remove', { sid, players: this.state.players.size });
  }

  onDispose() {
    GameRoom.instances.delete(this);
    this.logEvent('room_dispose');
  }

  /** Uniform random position inside the arena, away from the walls. */
  randomPos() {
    const m = this.half - 1.5;
    return { x: -m + Math.random() * m * 2, z: -m + Math.random() * m * 2 };
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
    this.logEvent('match_over', { winnerSid: this.state.winnerId, winnerName: this.state.winnerName });
  }

  /** Reset the match in place (play again / auto-restart), keep room + players. */
  resetMatch() {
    const state = this.state;
    for (const player of state.players.values()) {
      const p = this.randomPos();
      player.x = p.x;
      player.z = p.z;
      player.hp = SERVER.player.maxHp;
      player.score = 0;
      player.anim = 'idle';
      player.attackCd = 0;
      player.skillCd = 0;
      player.effects.clear(); // buffs never carry into the next match
    }
    // Scratch state: no stale cooldowns/input intents across matches.
    for (const sid of state.players.keys()) {
      this.inputs.set(sid, { dirX: 0, dirZ: 0 });
      this.attackAt.set(sid, 0);
      this.skillAt.set(sid, 0);
      this.invulnUntil.set(sid, 0);
      this.animUntil.set(sid, 0);
    }
    state.winnerId = '';
    state.winnerName = '';
    for (const orb of state.orbs) {
      const p = this.randomPos();
      orb.x = p.x;
      orb.z = p.z;
    }
    for (const enemy of state.enemies) {
      const p = this.randomPos();
      enemy.x = p.x;
      enemy.z = p.z;
      enemy.hp = SERVER.enemy.hp;
      enemy.anim = 'idle';
    }
    for (const pu of state.powerUps) {
      const p = this.randomPos();
      pu.x = p.x;
      pu.z = p.z;
      pu.active = true;
    }
    this.powerUpTimers.clear();
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
    this.inputs.set(sid, { dirX, dirZ });

    // Attack: only valid while the match is PLAYING (no swinging during the
    // countdown or on the game-over screen), and server-enforced cooldown —
    // swings inside the window are rejected (no anim, no melee).
    if (msg.attack) {
      if (this.state.matchState !== 'playing') {
        this.warnEvent('input_attack_rejected', { sid, reason: `match_${this.state.matchState}` });
        return;
      }
      if (now >= this.attackAt.get(sid)) {
        this.attackAt.set(sid, now + SERVER.player.attackCooldownMs);
        this.animUntil.set(sid, now + SERVER.player.attackAnimMs);
        this.melee(sid);
      } else {
        this.warnEvent('input_attack_rejected', { sid, reason: 'cooldown',
          cooldownMs: this.attackAt.get(sid) - now });
      }
    }

    // Skill cast (K): same gating as the melee; the cooldown + cast window come
    // from the caster's per-character skill def (src/shared/skills.js).
    if (msg.skill) {
      if (this.state.matchState !== 'playing') {
        this.warnEvent('input_skill_rejected', { sid, reason: `match_${this.state.matchState}` });
        return;
      }
      if (now >= this.skillAt.get(sid)) this.castSkill(sid);
      else this.warnEvent('input_skill_rejected', { sid, reason: 'cooldown' });
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
    player.hp = SERVER.player.maxHp;
    player.anim = 'idle';
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

  /** Melee swing from one player: damage every enemy in range + in front. */
  melee(sid) {
    const player = this.state.players.get(sid);
    if (!player || player.hp <= 0) return; // ghosts cannot swing
    player.anim = 'attack'; // movePlayers preserves this during animUntil
    const cfg = SERVER.player;
    // Facing vector from rotY (atan2 convention: +Z is 0).
    const fx = Math.sin(player.rotY);
    const fz = Math.cos(player.rotY);
    for (const enemy of this.state.enemies) {
      const dx = enemy.x - player.x;
      const dz = enemy.z - player.z;
      const dist = Math.hypot(dx, dz);
      if (dist > cfg.attackRange) continue;
      if ((dx * fx + dz * fz) / (dist || 1) < cfg.attackArcCos) continue;
      enemy.hp -= 1;
      enemy.anim = 'hit';
      this.enemyAnimUntil.set(enemy, Date.now() + SERVER.enemy.hitAnimMs);
      if (enemy.hp <= 0) {
        // Killed: respawn elsewhere, full HP.
        const p = this.randomPos();
        enemy.x = p.x;
        enemy.z = p.z;
        enemy.hp = SERVER.enemy.hp;
      }
    }
  }

  /**
   * Per-character skill cast (K). Every class shares the J melee but casts its
   * own skill (src/shared/skills.js) — distinct shape/damage/cooldown. The
   * caster is rooted for the cast (RC6) and shows anim='skill'. Like melee(),
   * damage applies to enemies only (PvE arena); killed enemies respawn.
   */
  castSkill(sid) {
    const state = this.state;
    const player = state.players.get(sid);
    if (!player || player.hp <= 0) return;
    const def = skillFor(player.character);
    const now = Date.now();
    if (now < this.skillAt.get(sid)) return; // belt + braces (onInput gates too)
    this.skillAt.set(sid, now + def.cooldownMs);
    this.animUntil.set(sid, now + def.animMs); // roots the caster during the cast
    player.anim = 'skill'; // movePlayers preserves this during animUntil

    // Resolve hits with the same pure math the client uses for its VFX, then
    // apply authoritative damage + respawn.
    const targets = [...state.enemies].map((e) => ({ x: e.x, z: e.z }));
    for (const i of resolveSkillHits(def, player, targets)) {
      const enemy = state.enemies[i];
      if (!enemy || enemy.hp <= 0) continue;
      enemy.hp -= def.damage;
      enemy.anim = 'hit';
      this.enemyAnimUntil.set(enemy, now + SERVER.enemy.hitAnimMs);
      if (enemy.hp <= 0) {
        const p = this.randomPos();
        enemy.x = p.x;
        enemy.z = p.z;
        enemy.hp = SERVER.enemy.hp;
      }
    }
    this.logEvent('skill_cast', { sid, character: player.character, skill: def.key });
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

    switch (state.matchState) {
      case 'lobby':
        // Free movement so players can warm up; no pickups, no enemies.
        this.movePlayers(dt);
        this.setEnemiesIdle();
        return;
      case 'countdown':
        // Frozen world; tick the 3-2-1-GO display down to zero.
        state.countdown = Math.max(0, state.countdown - dt);
        if (state.countdown <= 0) this.startPlaying();
        return;
      case 'playing':
        this.updatePlaying(dt);
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
        player.attackCd = 0;
        player.skillCd = 0;
        continue;
      }
      const { dirX, dirZ } = this.inputs.get(sid);
      const speed = SERVER.player.speed *
        (player.effects.has('speed') ? SERVER.powerUps.speed.multiplier : 1);
      // RC6: ROOT the player while mid-swing / mid-cast (animUntil). The
      // planted-feet attack/skill animation never skates the model across the
      // ground, and "move + attack at the same time" can no longer slide.
      const attacking = now < this.animUntil.get(sid);
      const stepped = stepPlayer(player.x, player.z, player.rotY,
        dirX, dirZ, speed, dt, this.half, attacking);
      player.x = stepped.x;
      player.z = stepped.z;
      player.rotY = stepped.rotY;
      // While the swing/cast override is active keep the anim melee/castSkill
      // set ('attack'/'skill'); otherwise drive it from movement.
      if (!attacking) player.anim = (dirX || dirZ) ? 'run' : 'idle';
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
    const msec = dt * 1000;

    this.movePlayers(dt);
    this.updateEffects(msec);

    // --- Orbs: first LIVING player within radius collects (server decides)
    const orbScore = (player) =>
      SERVER.orb.score * (player.effects.has('double') ? SERVER.powerUps.double.multiplier : 1);
    for (const orb of state.orbs) {
      for (const player of state.players.values()) {
        if (player.hp <= 0) continue; // corpses cannot collect
        const dx = orb.x - player.x;
        const dz = orb.z - player.z;
        if (dx * dx + dz * dz < SERVER.orb.radius * SERVER.orb.radius) {
          player.score += orbScore(player);
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
        const dx = pu.x - player.x;
        const dz = pu.z - player.z;
        if (dx * dx + dz * dz < SERVER.powerUps.radius * SERVER.powerUps.radius) {
          player.effects.set(pu.type, cfg.durationMs); // replace timer on re-pickup
          pu.active = false;
          this.powerUpTimers.set(pu, SERVER.powerUps.respawnSeconds);
          this.logEvent('player_pickup', { name: player.name, type: pu.type });
          break;
        }
      }
    }

    // --- Enemies: chase the nearest LIVING player, hurt on contact -------
    for (const enemy of state.enemies) {
      // 'hit'/'attack' anim overrides outlive the tick that set them;
      // while one is active the movement anim may not overwrite it.
      const animOverride = now < (this.enemyAnimUntil.get(enemy) || 0);
      if (!animOverride) this.enemyAnimUntil.delete(enemy);

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
        if (dist > SERVER.enemy.contactRange) {
          // Chase: step toward the target, staying server-authoritative.
          enemy.x += (target.x - enemy.x) / dist * SERVER.enemy.speed * dt;
          enemy.z += (target.z - enemy.z) / dist * SERVER.enemy.speed * dt;
          if (!animOverride) enemy.anim = 'run';
        } else if (now >= this.invulnUntil.get(targetSid)) {
          // Contact damage: 10 HP, 1s invulnerability, knockback away.
          // The SHIELD power-up absorbs the hit entirely (consumed).
          if (target.effects.has('shield')) {
            target.effects.delete('shield');
            this.enemyAnimUntil.set(enemy, now + SERVER.enemy.attackAnimMs);
            enemy.anim = 'attack';
            this.logEvent('shield_absorb', { sid: targetSid });
          } else {
            this.invulnUntil.set(targetSid, now + SERVER.player.invulnMs);
            this.enemyAnimUntil.set(enemy, now + SERVER.enemy.attackAnimMs);
            enemy.anim = 'attack'; // punch
            target.hp = Math.max(0, target.hp - SERVER.enemy.contactDamage);
            const kx = (target.x - enemy.x) / dist;
            const kz = (target.z - enemy.z) / dist;
            target.x = clamp(target.x + kx * SERVER.player.knockback * dt * 4, -this.half, this.half);
            target.z = clamp(target.z + kz * SERVER.player.knockback * dt * 4, -this.half, this.half);
          }
        } else if (!animOverride) {
          enemy.anim = 'idle'; // adjacent but the player is invulnerable
        }
      } else if (!animOverride) {
        enemy.anim = 'idle';
      }
    }

    // --- Win conditions (living players only — corpses cannot win) --------
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
  }
}
