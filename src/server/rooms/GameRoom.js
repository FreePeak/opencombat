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
import { waveEnemyCount, waveEnemyHp, spawnAwayFromPlayers } from '../../shared/waves.js';
import { blockedHit, meleeHits, strikeEnemy, strikePlayer } from '../../shared/combat.js';
import { attackFor } from '../../shared/classes.js';
import { stepProjectile, projectileExpired, projectileHitsTarget,
         resolveProjectileEnemyHit, resolveProjectilePlayerHit } from '../../shared/projectiles.js';
import { xpForLevel, rollUpgrades, getUpgrade, aggregateBonuses,
         effectiveMaxHp, effectiveSpeedMult, effectiveAttackCdMult, effectiveSkillCdMult,
         effectiveSkill, effectiveMeleeDamage, effectiveRangedDamage, effectiveXp, effectivePickupMult,
         AUTO_PICK_MS } from '../../shared/progression.js';

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
    this.enemyStunUntil = new Map();// enemy -> ms of HIT-STUN (no move/attack)
    this.pendingMelee = [];      // {sid, at} — impacts land mid-swing, not at press
    this.powerUpTimers = new Map(); // powerUp -> seconds until it respawns
    this._projectileId = 0;        // monotonic ID for projectile spawn
    this.pendingUntil = new Map(); // sid -> ms deadline for upgrade auto-pick
    this.pendingQueue = new Map(); // sid -> queued level-ups waiting for card pick

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
    // Wave gate: while the wave-cleared popup is up (matchState
    // 'intermission'), a click from ANY player starts the next wave for the
    // whole room — the popup on the other clients closes when the shared
    // matchState moves to 'countdown'.
    this.onMessage('nextWave', (client) => this.onNextWave(client));
    this.onMessage('chooseUpgrade', (client, msg) => this.onChooseUpgrade(client, msg));

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
   *  waveEnemyHp(n), spawned away from players; the rest drop dead. */
  spawnWave(n) {
    const count = waveEnemyCount(n);
    const hp = waveEnemyHp(n);
    const players = [...this.state.players.values()].filter((p) => p.hp > 0);
    this.state.enemies.forEach((enemy, i) => {
      this.enemyAnimUntil.delete(enemy);
      this.enemyStunUntil.delete(enemy);
      if (i < count) {
        const p = spawnAwayFromPlayers(players, () => this.randomPos());
        enemy.x = p.x;
        enemy.z = p.z;
        enemy.hp = hp;
        enemy.anim = 'idle';
      } else {
        enemy.hp = 0;
      }
    });
    this.state.wave = n;
    this.logEvent('wave_spawn', { wave: n, enemies: count, hp });
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
    this.pendingUntil.delete(sid);
    this.pendingQueue?.delete(sid);
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

  // -------------------------------------------------------------------------
  // Progression (Phase 4): XP, level-up, upgrade cards
  // -------------------------------------------------------------------------

  /** Grant `baseXp` to `sid`, respecting the Scholar bonus, then maybe level up. */
  grantXp(sid, baseXp) {
    const player = this.state.players.get(sid);
    if (!player) return;
    const amt = effectiveXp(baseXp, player.upgrades);
    if (amt <= 0) return;
    player.xp += amt;
    this.logEvent('xp_gain', { sid, amount: amt, total: player.xp });
    this.maybeLevelUp(sid);
  }

  /** While XP suffices for the next level, level up and roll 3 choices (or queue). */
  maybeLevelUp(sid) {
    const player = this.state.players.get(sid);
    if (!player) return;
    // Ensure queue storage exists
    if (!this.pendingQueue) this.pendingQueue = new Map();
    let queue = this.pendingQueue.get(sid);
    if (!queue) { queue = []; this.pendingQueue.set(sid, queue); }
    while (player.xp >= xpForLevel(player.level + 1)) {
      const nextLevel = player.level + 1;
      // If a card is already showing or there is a queue, don't show the new
      // level's cards immediately — level still increments (so the HUD updates)
      // but the cards are queued for after the current pick(s).
      if (player.pendingChoices.length > 0 || queue.length > 0) {
        player.level = nextLevel;
        queue.push(nextLevel);
        this.logEvent('level_queued', { sid, level: player.level, queued: queue.length });
        continue;
      }
      player.level = nextLevel;
      const seed = this.hashSeed(sid, player.level);
      const picks = rollUpgrades(seed, player.character, player.upgrades);
      // ArraySchema: clear then push
      while (player.pendingChoices.length) player.pendingChoices.pop();
      for (const id of picks) player.pendingChoices.push(id);
      const ms = SERVER.progression?.autoPickMs ?? AUTO_PICK_MS;
      this.pendingUntil.set(sid, Date.now() + ms);
      this.logEvent('level_up', { sid, level: player.level, choices: picks });
      // Tell the client via state patch + direct message for toast.
      const client = this.clients.find((c) => c.sessionId === sid);
      client?.send('levelUp', { level: player.level, choices: picks });
    }
  }

  /** Pop the next queued level-up (if any) and show its cards. */
  showNextQueued(sid) {
    const player = this.state.players.get(sid);
    if (!player) return;
    const queue = this.pendingQueue?.get(sid);
    if (!queue || queue.length === 0) return;
    const lvl = queue.shift(); // next queued level number
    // The player's level already reflects this queued level (incremented earlier),
    // so seed for `lvl` is correct. If queue had multiple, `lvl` is the smallest.
    const seed = this.hashSeed(sid, lvl);
    const picks = rollUpgrades(seed, player.character, player.upgrades);
    while (player.pendingChoices.length) player.pendingChoices.pop();
    for (const id of picks) player.pendingChoices.push(id);
    const ms = SERVER.progression?.autoPickMs ?? AUTO_PICK_MS;
    this.pendingUntil.set(sid, Date.now() + ms);
    this.logEvent('level_up_queued_show', { sid, level: lvl, choices: picks });
    const client = this.clients.find((c) => c.sessionId === sid);
    client?.send('levelUp', { level: lvl, choices: picks });
  }

  hashSeed(sid, level) {
    // Deterministic seed from sid + level (so the same level-up for the same
    // player always rolls the same 3 cards, but different players/levels differ).
    let h = 0;
    const s = sid + ':' + level;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h || 1;
  }

  /** Apply `upgradeId` to `player` (sid for logging), returns true if applied. */
  applyUpgrade(player, sid, upgradeId) {
    const def = getUpgrade(upgradeId);
    if (!def) return false;
    const cur = player.upgrades.get(upgradeId) || 0;
    if (cur >= (def.maxStacks ?? 99)) return false;
    player.upgrades.set(upgradeId, cur + 1);
    // Vitality: immediately heal the bonus so the pick feels impactful.
    if (upgradeId === 'vitality') {
      const maxHp = effectiveMaxHp(player.character, player.upgrades);
      player.hp = Math.min(maxHp, player.hp + 30);
    }
    this.logEvent('upgrade_pick', { sid, upgradeId, stacks: cur + 1, level: player.level });
    return true;
  }

  /** Auto-pick deadline check: every tick. */
  checkAutoPicks() {
    const now = Date.now();
    for (const [sid, deadline] of [...this.pendingUntil.entries()]) {
      if (now < deadline) continue;
      const player = this.state.players.get(sid);
      if (!player || player.pendingChoices.length === 0) {
        this.pendingUntil.delete(sid);
        continue;
      }
      const auto = player.pendingChoices[0];
      this.logEvent('upgrade_auto_pick', { sid, upgradeId: auto });
      while (player.pendingChoices.length) player.pendingChoices.pop();
      this.pendingUntil.delete(sid);
      this.applyUpgrade(player, sid, auto);
      const client = this.clients.find((c) => c.sessionId === sid);
      client?.send('upgradeResult', { picked: auto, auto: true });
      // If there are queued level-ups, show the next one; otherwise check for new XP-based levels.
      const queue = this.pendingQueue?.get(sid);
      if (queue && queue.length > 0) this.showNextQueued(sid);
      else this.maybeLevelUp(sid);
    }
  }

  /** Player picks one of their 3 pending upgrade cards. */
  onChooseUpgrade(client, msg = {}) {
    const sid = client.sessionId;
    const player = this.state.players.get(sid);
    if (!player) return;
    if (player.pendingChoices.length === 0) {
      this.warnEvent('upgrade_rejected', { sid, reason: 'no_pending' });
      return;
    }
    const choice = String(msg.choice ?? msg.id ?? '');
    if (!player.pendingChoices.includes(choice)) {
      this.warnEvent('upgrade_rejected', { sid, reason: 'not_offered', choice });
      return;
    }
    while (player.pendingChoices.length) player.pendingChoices.pop();
    this.pendingUntil.delete(sid);
    const ok = this.applyUpgrade(player, sid, choice);
    if (!ok) {
      this.warnEvent('upgrade_rejected', { sid, reason: 'apply_failed', choice });
      return;
    }
    client.send('upgradeResult', { picked: choice, auto: false });
    const queue = this.pendingQueue?.get(sid);
    if (queue && queue.length > 0) this.showNextQueued(sid);
    else this.maybeLevelUp(sid);
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
      player.hp = statsOf(player).hp; // Phase 3: per-class base HP
      player.score = 0;
      player.anim = 'idle';
      player.blocking = false;
      player.attackCd = 0;
      player.skillCd = 0;
      player.effects.clear(); // buffs never carry into the next match
      // Phase 4: fresh match = back to level 1, no cards
      player.level = 1;
      player.xp = 0;
      while (player.pendingChoices.length) player.pendingChoices.pop();
      player.upgrades.clear();
    }
    // Scratch state: no stale cooldowns/input intents across matches.
    for (const sid of state.players.keys()) {
      this.inputs.set(sid, { dirX: 0, dirZ: 0 });
      this.attackAt.set(sid, 0);
      this.skillAt.set(sid, 0);
      this.invulnUntil.set(sid, 0);
      this.animUntil.set(sid, 0);
      this.pendingUntil.delete(sid);
      this.pendingQueue?.delete(sid);
    }
    state.winnerId = '';
    state.winnerName = '';
    for (const orb of state.orbs) {
      const p = this.randomPos();
      orb.x = p.x;
      orb.z = p.z;
    }
    // Fresh match = wave 1 (spawnWave clears every enemy stun/anim override).
    this.pendingMelee = [];
    this.spawnWave(1);
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

  /** Click on the wave-cleared popup: spawn the next wave + countdown. */
  onNextWave(client) {
    if (this.state.matchState !== 'intermission') return; // popup-gated
    const next = this.state.wave + 1;
    this.logEvent('wave_next', { sid: client.sessionId, wave: next });
    this.pendingMelee = []; // no stale impacts bleeding into the new wave
    this.spawnWave(next);
    this.startCountdown();
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
    strikePlayer(victim, amount, srcX, srcZ, SERVER.player.knockback * 0.15, this.half);
    // Hit react: brief 'hit' anim override (300ms) so all clients see the
    // victim flinch — mirrors the enemy hit-stun pattern.
    victim.anim = 'hit';
    this.animUntil.set(sid, now + 300);
    return true;
  }

  /**
   * Apply one hit of `damage` to a LIVING enemy from (srcX, srcZ):
   * HIT-STUN (the enemy stops chasing/attacking for hitStunMs and plays the
   * hit react), a small knockback away from the attacker, and — on kill —
   * the enemy STAYS DEAD (no respawn) and the killer scores. Returns true
   * when the hit killed the enemy.
   */
  hitEnemy(enemy, damage, srcX, srcZ, killer) {
    // Shared strike math: HP drop + knockback, dead-stays-dead guard.
    const { hit, killed } = strikeEnemy(enemy, damage, srcX, srcZ, SERVER.enemy.hitKnockback, this.half);
    if (!hit) return false;
    if (killed) {
      if (killer) {
        killer.score += SERVER.enemy.killScore;
        // Phase 4: XP on kill
        const sid = [...this.state.players.entries()].find(([, p]) => p === killer)?.[0];
        if (sid) this.grantXp(sid, SERVER.progression?.xpPerKill ?? 30);
      }
      this.logEvent('enemy_killed', { wave: this.state.wave, by: killer?.name });
      return true;
    }
    // Survived the hit: stagger — no chase, no contact damage until the
    // stun expires (this is what makes hits read as impactful).
    const now = Date.now();
    enemy.anim = 'hit';
    this.enemyAnimUntil.set(enemy, now + SERVER.enemy.hitAnimMs);
    this.enemyStunUntil.set(enemy, now + SERVER.enemy.hitStunMs);
    return false;
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
      this.hitEnemy(enemy, dmg, player.x, player.z, player);
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
          const { hit, killed } = strikeEnemy(enemy, dmg, player.x, player.z, def.knockback, this.half);
          if (hit) {
            if (killed) {
              player.score += SERVER.enemy.killScore;
              this.grantXp(sid, SERVER.progression?.xpPerKill ?? 30);
              this.logEvent('enemy_killed', { wave: state.wave, by: player.name });
            } else {
              enemy.anim = 'hit';
              this.enemyAnimUntil.set(enemy, now + SERVER.enemy.hitAnimMs);
              this.enemyStunUntil.set(enemy, now + (def.stunDurationMs || 1000));
            }
          }
        } else {
          this.hitEnemy(enemy, dmg, player.x, player.z, player);
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
          this._burnByProjId = this._burnByProjId || new Map();
          this._burnByProjId.set(proj.id, pDef.effects.burn);
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
   * updatePlaying() each fixed timestep.
   */
  updateProjectiles(dt) {
    const state = this.state;
    const hitRadius = SERVER.projectile.hitRadius;
    for (let i = state.projectiles.length - 1; i >= 0; i--) {
      const proj = state.projectiles[i];
      stepProjectile(proj, dt);

      // Expired (TTL or out of arena)?
      if (projectileExpired(proj, this.half)) {
        state.projectiles.splice(i, 1);
        continue;
      }

      let removed = false;

      // Hit enemies?
      if (proj.ownerIsPlayer) {
        for (const enemy of state.enemies) {
          if (enemy.hp <= 0) continue;
          if (projectileHitsTarget(proj, enemy, hitRadius)) {
            this.hitEnemy(enemy, proj.damage, proj.x, proj.z,
              state.players.get(proj.ownerSid));
            // Firewave burn DoT: apply burn when a fireball hits
            if (this._burnByProjId && this._burnByProjId.has(proj.id)) {
              const burn = this._burnByProjId.get(proj.id);
              this._burnByProjId.delete(proj.id);
              this._activeBurns = this._activeBurns || new Map();
              this._activeBurns.set(enemy, {
                damage: burn.damage,
                remainingMs: burn.durationMs,
                tickMs: burn.tickMs,
                lastTickMs: Date.now(),
              });
            }
            state.projectiles.splice(i, 1);
            removed = true;
            break;
          }
        }
      }

      // PvP: hit other players?
      if (!removed && proj.ownerIsPlayer) {
        for (const [osid, victim] of state.players) {
          if (osid === proj.ownerSid || victim.hp <= 0) continue;
          if (projectileHitsTarget(proj, victim, hitRadius)) {
            this.damagePlayer(osid, victim, proj.damage, proj.x, proj.z);
            state.projectiles.splice(i, 1);
            removed = true;
            break;
          }
        }
      }
    }
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

    // Phase 4: auto-pick stalled upgrade cards (PvP must never block)
    this.checkAutoPicks();

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
      case 'intermission':
        // Wave cleared: free movement + pickups, NO enemies (all dead), and
        // everyone is invulnerable (damagePlayer gates on 'playing'). The
        // only way forward is a 'nextWave' click.
        this.movePlayers(dt);
        this.updateEffects(dt * 1000);
        this.updatePickups(dt);
        this.checkWinConditions(dt);
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
        if (dist > SERVER.enemy.contactRange) {
          // Chase: step toward the target, staying server-authoritative.
          enemy.x += (target.x - enemy.x) / dist * SERVER.enemy.speed * dt;
          enemy.z += (target.z - enemy.z) / dist * SERVER.enemy.speed * dt;
          if (!animOverride) enemy.anim = 'run';
        } else if (now >= this.invulnUntil.get(targetSid)) {
          // Contact damage, resolved through damagePlayer: a successful BLOCK
          // (guarding + enemy in front) negates it, the SHIELD power-up
          // absorbs one hit, otherwise the target takes damage + knockback.
          this.enemyAnimUntil.set(enemy, now + SERVER.enemy.attackAnimMs);
          enemy.anim = 'attack'; // punch (swings even when blocked)
          this.damagePlayer(targetSid, target, SERVER.enemy.contactDamage, enemy.x, enemy.z);
        } else if (!animOverride) {
          enemy.anim = 'idle'; // adjacent but the player is invulnerable
        }
      } else if (!animOverride) {
        enemy.anim = 'idle';
      }
    }

    // --- Wave cleared: every enemy dead -> intermission ------------------
    // The popup waits for a player click; players are invulnerable until
    // the next wave starts.
    if (state.enemies.length > 0 && alive === 0) {
      state.matchState = 'intermission';
      this.pendingMelee = [];
      this.logEvent('wave_cleared', { wave: state.wave });
      return;
    }

    this.checkWinConditions(dt);
  }

  /** Orb + power-up pickups (shared by 'playing' and 'intermission'). */
  updatePickups(dt) {
    const state = this.state;
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
    // Burn DoT: tick damage on burning enemies
    if (this._activeBurns) {
      const now = Date.now();
      for (const [enemy, burn] of this._activeBurns) {
        if (enemy.hp <= 0) { this._activeBurns.delete(enemy); continue; }
        const elapsed = now - burn.lastTickMs;
        if (elapsed >= burn.tickMs) {
          enemy.hp = Math.max(0, enemy.hp - burn.damage);
          burn.lastTickMs = now;
          burn.remainingMs -= elapsed;
        }
        if (burn.remainingMs <= 0) this._activeBurns.delete(enemy);
      }
    }
  }
}
