// The one gameplay room. Owns the match lifecycle (LOBBY -> COUNTDOWN ->
// PLAYING -> GAME_OVER) and the fixed-timestep simulation: movement
// integration, shared orb pickups, power-ups, enemy AI, melee, damage and
// knockback. Clients only send input intents — every outcome below is
// authoritative, including the state transitions (clients just render
// matchState + countdown).
import { Room, CloseCode } from 'colyseus';
import { WorldState, PlayerState, OrbState, PowerUpState, EnemyState } from '../schema/StateSchema.js';
import { SERVER } from '../config.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Simple string hash: same name -> same color, stable across joins.
function nameHash(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

export default class GameRoom extends Room {
  onCreate() {
    this.setState(new WorldState());

    // Per-session scratch state, kept out of the schema (no reason to
    // broadcast input buffers or timers).
    this.inputs = new Map();        // sessionId -> { dirX, dirZ } last intent
    this.attackAt = new Map();      // sessionId -> ms when J may swing again
    this.invulnUntil = new Map();   // sessionId -> ms of damage immunity
    this.animUntil = new Map();     // sessionId -> ms anim override ('attack') expires
    this.msgTimes = new Map();      // sessionId -> recent input timestamps (rate cap)
    this.graceTimers = new Map();   // sessionId -> timeout handle for reconnect grace
    this.enemyAnimUntil = new Map();// enemy -> ms of 'hit'/'attack' anim override
    this.powerUpTimers = new Map(); // powerUp -> seconds until it respawns

    this.half = SERVER.world.size / 2; // arena half-extent on X and Z
    this.matchElapsed = 0;          // seconds into the playing phase (timed mode)

    this.spawnOrbs();
    this.spawnEnemies();
    this.spawnPowerUps();

    // --- Messages -------------------------------------------------------
    this.onMessage('input', (client, msg) => this.onInput(client, msg));
    this.onMessage('respawn', (client) => this.onRespawn(client));
    this.onMessage('playAgain', (client) => this.onPlayAgain(client));

    // --- Fixed-timestep loop --------------------------------------------
    this.clock.setInterval(() => this.update(SERVER.tickMs / 1000), SERVER.tickMs);
  }

  /** Sanitize the pre-join name (join options) for display everywhere. */
  sanitizeName(raw) {
    const name = String(raw ?? '').trim().slice(0, 16);
    return name || 'player';
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

  onJoin(client, options = {}) {
    // Reconnect path: a player with a live seat rejoins — keep their
    // position/score/hp, just refresh the connection-scoped scratch state.
    let player = this.state.players.get(client.sessionId);
    if (player) {
      console.log(`[game] ${client.sessionId} reconnected as '${player.name}'`);
    } else {
      const name = this.sanitizeName(options.name);
      const p = this.randomPos();
      player = new PlayerState(p.x, p.z);
      player.name = name;
      player.color = SERVER.colors[nameHash(name) % SERVER.colors.length];
      this.state.players.set(client.sessionId, player);
      console.log(`[game] '${name}' joined (${this.state.players.size} online)`);
    }

    this.inputs.set(client.sessionId, { dirX: 0, dirZ: 0 });
    this.attackAt.set(client.sessionId, 0);
    this.invulnUntil.set(client.sessionId, 0);
    this.animUntil.set(client.sessionId, 0);
    this.msgTimes.set(client.sessionId, []);
    clearTimeout(this.graceTimers.get(client.sessionId));
    this.graceTimers.delete(client.sessionId);

    // Match start (documented choice): the countdown begins as soon as the
    // minPlayers threshold is met — default 1, i.e. the first player.
    if (this.state.matchState === 'lobby' && this.state.players.size >= SERVER.match.minPlayers) {
      this.startCountdown();
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
      this.allowReconnection(client, SERVER.match.reconnectGraceMs / 1000);
      const timer = setTimeout(() => this.removePlayer(sid), SERVER.match.reconnectGraceMs);
      this.graceTimers.set(sid, timer);
      console.log(`[game] ${sid} dropped, seat held for ${SERVER.match.reconnectGraceMs}ms`);
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
    console.log(`[game] ${sid} removed (${this.state.players.size} online)`);
  }

  onDispose() {
    console.log('[game] room disposed');
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
    console.log('[game] countdown ' + SERVER.match.countdownSeconds + '...');
  }

  /** COUNTDOWN -> PLAYING (the only place the GO transition happens). */
  startPlaying() {
    this.state.matchState = 'playing';
    this.state.countdown = 0;
    this.matchElapsed = 0;
    console.log('[game] GO!');
  }

  /** End the match: pick the winner, broadcast, freeze the simulation. */
  endMatch(winnerSid) {
    this.state.matchState = 'gameover';
    this.state.countdown = 0;
    this.state.winnerId = winnerSid;
    const w = this.state.players.get(winnerSid);
    this.state.winnerName = w ? w.name : '';
    console.log(`[game] game over — winner '${this.state.winnerName}'`);
  }

  /** "Play again": reset the match in place, keep the room + players. */
  onPlayAgain(client) {
    if (this.state.matchState !== 'gameover') return; // only after a match
    const state = this.state;
    for (const player of state.players.values()) {
      const p = this.randomPos();
      player.x = p.x;
      player.z = p.z;
      player.hp = SERVER.player.maxHp;
      player.score = 0;
      player.anim = 'idle';
      player.effects.clear();
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
    console.log('[game] match reset — new countdown');
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
      console.warn(`[game] dropping input from ${sid} (> ${SERVER.net.maxInputPerSecond}/s)`);
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

    // Attack: server-enforced cooldown — swings inside the window are
    // rejected (no anim, no melee).
    if (msg.attack && now >= this.attackAt.get(sid)) {
      this.attackAt.set(sid, now + SERVER.player.attackCooldownMs);
      this.animUntil.set(sid, now + SERVER.player.attackAnimMs);
      this.melee(sid);
    } else if (msg.attack) {
      console.warn(`[game] ${sid} attack rejected (cooldown ${this.attackAt.get(sid) - now}ms left)`);
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
    this.invulnUntil.set(client.sessionId, Date.now() + 1000); // spawn grace
    console.log(`[game] ${client.sessionId} respawned`);
  }

  /** Melee swing from one player: damage every enemy in range + in front. */
  melee(sid) {
    const player = this.state.players.get(sid);
    if (!player) return;
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

  /** One fixed timestep of the simulation, dispatched by match phase. */
  update(dt) {
    const state = this.state;
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
      const { dirX, dirZ } = this.inputs.get(sid);
      const speed = SERVER.player.speed *
        (player.effects.has('speed') ? SERVER.powerUps.speed.multiplier : 1);
      player.x = clamp(player.x + dirX * speed * dt, -this.half, this.half);
      player.z = clamp(player.z + dirZ * speed * dt, -this.half, this.half);
      if (dirX || dirZ) player.rotY = Math.atan2(dirX, dirZ);
      // Cosmetic anim: the swing overrides movement while it lasts.
      player.anim = now < this.animUntil.get(sid) ? 'attack'
        : (dirX || dirZ) ? 'run' : 'idle';
      // Broadcast the cooldown for the HUD bar (0 = ready to swing).
      player.attackCd = Math.max(0, this.attackAt.get(sid) - now);
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

    // --- Orbs: first player within radius collects (server decides) -----
    const orbScore = (player) =>
      SERVER.orb.score * (player.effects.has('double') ? SERVER.powerUps.double.multiplier : 1);
    for (const orb of state.orbs) {
      for (const player of state.players.values()) {
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
        const dx = pu.x - player.x;
        const dz = pu.z - player.z;
        if (dx * dx + dz * dz < SERVER.powerUps.radius * SERVER.powerUps.radius) {
          player.effects.set(pu.type, cfg.durationMs); // replace timer on re-pickup
          pu.active = false;
          this.powerUpTimers.set(pu, SERVER.powerUps.respawnSeconds);
          console.log(`[game] '${player.name}' picked up ${pu.type}`);
          break;
        }
      }
    }

    // --- Enemies: chase the nearest player, hurt on contact -------------
    for (const enemy of state.enemies) {
      // 'hit'/'attack' anim overrides outlive the tick that set them;
      // while one is active the movement anim may not overwrite it.
      const animOverride = now < (this.enemyAnimUntil.get(enemy) || 0);
      if (!animOverride) this.enemyAnimUntil.delete(enemy);

      let targetSid = null;   // sessionId of the nearest player
      let target = null;
      let best = Infinity;
      for (const [sid, player] of state.players) {
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
            console.log(`[game] '${target.name}' shield absorbed a hit`);
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

    // --- Win conditions ---------------------------------------------------
    if (SERVER.match.targetScore > 0) {
      for (const [sid, player] of state.players) {
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
          if (player.score > bestScore) { bestScore = player.score; winnerSid = sid; }
        }
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
