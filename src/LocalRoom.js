// LocalRoom: a browser-local Colyseus Room replacement.
// Runs the same game logic as GameRoom (movement, orbs, enemies, skills, wave
// lifecycle, match lifecycle) but entirely in the browser — no server, no
// WebSocket. Used for GitHub Pages static hosting.

import { WorldState, PlayerState, OrbState, EnemyState, PowerUpState } from './server/schema/StateSchema.js';
import { SERVER } from './server/config.js';
import { stepPlayer } from './server/movement.js';
import { skillFor, resolveSkillHits } from './shared/skills.js';
import { waveEnemyCount, waveEnemyHp, spawnAwayFromPlayers } from './shared/waves.js';
import { blockedHit, meleeHits, strikeEnemy, strikePlayer } from './shared/combat.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Deterministic RNG (LCG) for prop placement + orb/enemy spawns — same as GameScene
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomInCircle(rng, radius) {
  const r = Math.sqrt(rng()) * radius;
  const theta = rng() * Math.PI * 2;
  return { x: r * Math.cos(theta), z: r * Math.sin(theta) };
}

export class LocalRoom {
  constructor() {
    this.state = new WorldState();
    this.sessionId = 'local-' + Math.random().toString(36).slice(2);
    this._callbacks = { stateChange: [], message: [], leave: [] };
    this._tickId = null;
    this._lastTime = performance.now();
    this._running = false;
    this._myPlayerId = null;
    this._playerInput = { dirX: 0, dirZ: 0, attack: false, skill: false, anim: '', block: false };
    this._rng = makeRng(0xC0FFEE); // deterministic seed
    this._matchEnded = false;
    this._enemyAnimUntil = new Map();  // enemy -> ms of 'hit'/'attack' override
    this._enemyStunUntil = new Map();  // enemy -> ms of HIT-STUN (no actions)
    this._pendingStrikes = [];         // {sid, at} — melee impacts land mid-swing
    // Browsers drive the sim with rAF; headless environments (the test suite)
    // get a 16ms timer so the same room class runs in Node.
    this._raf = typeof requestAnimationFrame === 'function';
  }

  // --- Colyseus Room API subset --------------------------------------------

  onStateChange(fn) { this._callbacks.stateChange.push(fn); }
  onMessage(type, fn) { this._callbacks.message.push({ type, fn }); }
  onLeave(fn) { this._callbacks.leave.push(fn); }
  // A local room has no socket, so it can never drop or reconnect — GameScene
  // wires these like on any network room, so they must exist as no-ops.
  onDrop(_fn) {}
  onReconnect(_fn) {}

  /** Fire a registered onMessage handler (the server sends 'blocked' etc.). */
  _emitMessage(type, data) {
    for (const m of this._callbacks.message) {
      if (m.type === type) m.fn(data);
    }
  }

  send(type, data) {
    if (type === 'input') this._playerInput = data;
    else if (type === 'respawn') this._requestRespawn();
    else if (type === 'playAgain') this._resetMatch();
    else if (type === 'nextWave') this._requestNextWave();
  }

  // --- Lifecycle -------------------------------------------------------------

  async join(name, character) {
    this._initWorld(name, character);
    this._running = true;
    this._lastTime = performance.now();
    this._tick();
    return this;
  }

  _initWorld(name, character) {
    const half = SERVER.world.size / 2;

    // Local player
    const me = new PlayerState(0, 0);
    me.name = name.slice(0, 16);
    me.character = clamp(character, 0, SERVER.characters.count - 1);
    me.color = SERVER.colors[0];
    me.hp = SERVER.player.maxHp;
    this.state.players.set(this.sessionId, me);
    this._myPlayerId = this.sessionId;

    // Orbs
    for (let i = 0; i < SERVER.orb.count; i++) {
      const pos = randomInCircle(this._rng, half - 2);
      this.state.orbs.push(new OrbState(pos.x, pos.z));
    }

    // Enemy pool (dead until the wave activates their slot — see waves.js)
    for (let i = 0; i < SERVER.enemy.pool; i++) {
      this.state.enemies.push(new EnemyState(0, 0));
    }
    this._spawnWave(1);

    // Power-ups (one of each type)
    const types = ['speed', 'shield', 'double'];
    for (const type of types) {
      const pos = randomInCircle(this._rng, half - 2);
      const p = new PowerUpState(pos.x, pos.z, type);
      p.active = true;
      this.state.powerUps.push(p);
    }

    // Match state
    this.state.matchState = 'countdown';
    this.state.countdown = SERVER.match.countdownSeconds;
    this._countdownTimer = SERVER.match.countdownSeconds * 1000;
    this._notifyStateChange();
  }

  leave() {
    this._running = false;
    if (this._tickId != null) {
      if (this._raf) cancelAnimationFrame(this._tickId);
      else clearTimeout(this._tickId);
      this._tickId = null;
    }
    // 4000 = CONSENTED (deliberate leave). GameScene only engages its
    // socket-reconnect machinery for other codes — a local room must never
    // trigger it.
    for (const fn of this._callbacks.leave) fn(4000);
  }

  // --- Game loop -------------------------------------------------------------

  _tick() {
    if (!this._running) return;
    this._tickId = this._raf
      ? requestAnimationFrame(() => this._tick())
      : setTimeout(() => this._tick(), 16);

    const now = performance.now();
    const dt = Math.min((now - this._lastTime) / 1000, 0.05); // clamp same as server
    this._lastTime = now;

    this._step(dt);
  }

  /** Activate wave `n` out of the fixed pool (mirror of GameRoom.spawnWave). */
  _spawnWave(n) {
    const half = SERVER.world.size / 2;
    const count = waveEnemyCount(n);
    const hp = waveEnemyHp(n);
    const players = [...this.state.players.values()].filter((p) => p.hp > 0);
    this.state.enemies.forEach((enemy, i) => {
      this._enemyAnimUntil.delete(enemy);
      this._enemyStunUntil.delete(enemy);
      if (i < count) {
        const pos = spawnAwayFromPlayers(players, () => randomInCircle(this._rng, half - 2));
        enemy.x = pos.x;
        enemy.z = pos.z;
        enemy.hp = hp;
        enemy.anim = 'idle';
      } else {
        enemy.hp = 0;
      }
    });
    this.state.wave = n;
  }

  _step(dt) {
    const half = SERVER.world.size / 2;
    const players = this.state.players;
    const me = players.get(this.sessionId);

    // Countdown
    if (this.state.matchState === 'countdown') {
      this._countdownTimer -= dt * 1000;
      this.state.countdown = Math.ceil(this._countdownTimer / 1000);
      if (this._countdownTimer <= 0) {
        this.state.matchState = 'playing';
        this.state.countdown = 0;
      }
      this._notifyStateChange();
      return;
    }

    if (this.state.matchState === 'gameover') return;

    const playing = this.state.matchState === 'playing';
    const intermission = this.state.matchState === 'intermission';

    // --- Scheduled melee impacts (damage lands mid-swing, see GameRoom) ---
    if (playing) {
      const now = performance.now();
      for (let i = this._pendingStrikes.length - 1; i >= 0; i--) {
        if (now >= this._pendingStrikes[i].at) {
          this._pendingStrikes.splice(i, 1);
          if (me && me.hp > 0) this._resolveMelee(me);
        }
      }
    } else {
      this._pendingStrikes = [];
    }

    // --- Local player input + movement (runs in 'playing' AND 'intermission':
    //     the wave-cleared breather keeps free movement, just no combat) ---
    if (me && me.hp > 0) {
      const { dirX: inX, dirZ: inZ } = this._playerInput;
      // Combat rules mirror GameRoom: holding L (block) roots the player, and
      // attacks/skills cannot be started while blocking (but work while moving).
      me.blocking = !!this._playerInput.block;
      const dirX = me.blocking ? 0 : inX;
      const dirZ = me.blocking ? 0 : inZ;
      const moved = stepPlayer(me.x, me.z, me.rotY, dirX, dirZ, SERVER.player.speed, dt, half);
      me.x = moved.x;
      me.z = moved.z;
      me.rotY = moved.rotY;

      // Attack (J) — playing only, rejected while blocking. The strike is
      // SCHEDULED: damage lands attackImpactMs in, aligned with the swing.
      if (playing && this._playerInput.attack && me.attackCd <= 0 && !me.blocking) {
        me.attackCd = SERVER.player.attackCooldownMs;
        me.anim = 'attack';
        me.animUntil = performance.now() + SERVER.player.attackAnimMs;
        this._pendingStrikes.push({ at: performance.now() + SERVER.player.attackImpactMs });
      }

      // Skill (K) — same gating as the melee; skills resolve at cast (their
      // VFX burst reads as the hit moment). Works while moving.
      if (playing && this._playerInput.skill && me.skillCd <= 0 && !me.blocking) {
        const skill = skillFor(me.character);
        me.skillCd = skill.cooldownMs;
        me.anim = 'skill';
        me.animUntil = performance.now() + skill.animMs;
        this._resolveSkill(me, skill);
      }

      // Cooldowns
      if (me.attackCd > 0) me.attackCd -= dt * 1000;
      if (me.skillCd > 0) me.skillCd -= dt * 1000;
      if (me.animUntil && performance.now() > me.animUntil) {
        me.anim = (dirX || dirZ) ? 'run' : 'idle';
        me.animUntil = 0;
      } else if (!me.animUntil && (dirX || dirZ)) {
        me.anim = 'run';
      } else if (!me.animUntil) {
        me.anim = 'idle';
      }

      // Effect timers
      this._updateEffects(me, dt * 1000);
    }

    // --- Enemies (playing only — intermission has none alive) ------------
    if (playing) {
      const now = performance.now();
      let alive = 0;
      for (const enemy of this.state.enemies) {
        if (enemy.hp <= 0) continue; // dead stays dead until the next wave
        alive++;

        // HIT-STUN: a struck enemy stops acting until the stun expires —
        // the anim override alone let it keep chasing through the react.
        if (now < (this._enemyStunUntil.get(enemy) || 0)) {
          enemy.anim = 'hit';
          continue;
        }
        this._enemyStunUntil.delete(enemy);
        const animOverride = now < (this._enemyAnimUntil.get(enemy) || 0);

        // Find nearest living player
        let target = null;
        let bestDist = Infinity;
        for (const p of players.values()) {
          if (p.hp <= 0) continue;
          const d = Math.hypot(p.x - enemy.x, p.z - enemy.z);
          if (d < bestDist) { bestDist = d; target = p; }
        }

        if (target) {
          const dx = target.x - enemy.x;
          const dz = target.z - enemy.z;
          const dist = Math.hypot(dx, dz);
          enemy.rotY = Math.atan2(dx, dz);
          const targetInvuln = target._lastHit && (now - target._lastHit) < SERVER.player.invulnMs;
          if (dist > SERVER.enemy.contactRange) {
            if (dist > 1e-3) {
              enemy.x = clamp(enemy.x + (dx / dist) * SERVER.enemy.speed * dt, -half, half);
              enemy.z = clamp(enemy.z + (dz / dist) * SERVER.enemy.speed * dt, -half, half);
            }
            if (!animOverride) enemy.anim = 'run';
          } else if (!targetInvuln) {
            // Contact damage — punch anim swings even when the hit is
            // blocked (same feedback as the server room).
            this._enemyAnimUntil.set(enemy, now + SERVER.enemy.attackAnimMs);
            enemy.anim = 'attack';
            this._damagePlayer(target, SERVER.enemy.contactDamage, enemy);
          } else if (!animOverride) {
            enemy.anim = 'idle'; // adjacent but the target is invulnerable
          }
        } else if (!animOverride) {
          enemy.anim = 'idle';
        }
      }

      // Wave cleared -> intermission (click-gated next wave, players safe)
      if (this.state.enemies.length > 0 && alive === 0) {
        this.state.matchState = 'intermission';
        this._pendingStrikes = [];
        this._notifyStateChange();
        return;
      }
    }

    // --- Orbs: pickup (playing + intermission) ----------------------------
    for (const orb of this.state.orbs) {
      for (const p of players.values()) {
        if (p.hp <= 0) continue;
        const d = Math.hypot(p.x - orb.x, p.z - orb.z);
        if (d <= SERVER.orb.radius + SERVER.player.radius) {
          let score = SERVER.orb.score;
          if (p.effects.has('double')) score *= 2;
          p.score += score;
          // Respawn orb
          const pos = randomInCircle(this._rng, half - 2);
          orb.x = pos.x;
          orb.z = pos.z;
          break;
        }
      }
    }

    // --- Power-ups: pickup (playing + intermission) -----------------------
    for (const pu of this.state.powerUps) {
      if (!pu.active) continue;
      for (const p of players.values()) {
        if (p.hp <= 0) continue;
        const d = Math.hypot(p.x - pu.x, p.z - pu.z);
        if (d <= SERVER.powerUps.radius + SERVER.player.radius) {
          pu.active = false;
          p.effects.set(pu.type, pu.type === 'speed' ? SERVER.powerUps.speed.durationMs
                          : pu.type === 'shield' ? SERVER.powerUps.shield.durationMs
                          : SERVER.powerUps.double.durationMs);
          // Respawn after delay
          setTimeout(() => {
            const pos = randomInCircle(this._rng, half - 2);
            pu.x = pos.x;
            pu.z = pos.z;
            pu.active = true;
            this._notifyStateChange();
          }, SERVER.powerUps.respawnSeconds * 1000);
          break;
        }
      }
    }

    // --- Win check (targetScore) ------------------------------------------
    if (SERVER.match.targetScore > 0 && !this._matchEnded) {
      for (const p of players.values()) {
        if (p.score >= SERVER.match.targetScore) {
          this._endMatch(p);
          break;
        }
      }
    }

    this._notifyStateChange();
  }

  /** Shared enemy-hit resolution (mirror of GameRoom.hitEnemy): knockback,
   *  HIT-STUN on survivors, stay-dead + kill score on kills. */
  _hitEnemy(enemy, damage, srcX, srcZ, killer) {
    const { hit, killed } = strikeEnemy(enemy, damage, srcX, srcZ, SERVER.enemy.hitKnockback, SERVER.world.size / 2);
    if (!hit) return false;
    if (killed) {
      if (killer) killer.score += SERVER.enemy.killScore;
      return true;
    }
    const now = performance.now();
    enemy.anim = 'hit';
    this._enemyAnimUntil.set(enemy, now + SERVER.enemy.hitAnimMs);
    this._enemyStunUntil.set(enemy, now + SERVER.enemy.hitStunMs);
    return false;
  }

  _resolveMelee(attacker) {
    // Shared arc math: which enemies this swing covers (dead ones skipped).
    for (const i of meleeHits(attacker, this.state.enemies, SERVER.player)) {
      const enemy = this.state.enemies[i];
      // Hit: the enemy stays down at 0 HP until the next wave revives
      // its slot (killed enemies no longer teleport-respawn).
      this._hitEnemy(enemy, SERVER.player.attackDamage, attacker.x, attacker.z, attacker);
    }
  }

  _resolveSkill(caster, skill) {
    const hits = resolveSkillHits(skill, caster, [...this.state.enemies]);
    for (const idx of hits) {
      const enemy = this.state.enemies[idx];
      if (!enemy || enemy.hp <= 0) continue;
      this._hitEnemy(enemy, skill.damage, caster.x, caster.z, caster);
    }
  }

  /** One hit against the local player: outside 'playing' (intermission!)
   *  everyone is INVULNERABLE; BLOCK (frontal) negates it entirely, the
   *  SHIELD power-up absorbs one hit, otherwise HP drops. */
  _damagePlayer(player, amount, source) {
    if (this.state.matchState !== 'playing') return false;
    if (source && blockedHit(player, source.x, source.z, SERVER.player.blockArcCos)) {
      this._emitMessage('blocked', { x: player.x, z: player.z });
      return false;
    }
    if (player.effects.has('shield')) {
      player.effects.delete('shield'); // shield blocks one hit
      return false;
    }
    const now = performance.now();
    if (player._lastHit && now - player._lastHit < SERVER.player.invulnMs) return false;
    player._lastHit = now;
    // Knockback 0: the offline sim has never shoved the player (server does,
    // via strikePlayer with the configured nudge) — one code path, per-room.
    strikePlayer(player, amount, source?.x ?? player.x, source?.z ?? player.z, 0, SERVER.world.size / 2);
    if (player.hp <= 0) {
      player.anim = 'hit';
    }
    return true;
  }

  _updateEffects(player, msec) {
    const expired = [];
    for (const [name, ms] of player.effects) {
      const left = ms - msec;
      if (left <= 0) expired.push(name);
      else player.effects.set(name, left);
    }
    for (const name of expired) player.effects.delete(name);
  }

  _requestRespawn() {
    const me = this.state.players.get(this.sessionId);
    if (me && me.hp <= 0 && this.state.matchState !== 'gameover') {
      me.hp = SERVER.player.maxHp;
      me.x = 0;
      me.z = 0;
      me.rotY = 0;
      me.anim = 'idle';
      me.blocking = false;
      me.effects.clear();
      this._notifyStateChange();
    }
  }

  /** Click on the wave-cleared popup: next wave + countdown (popup-gated). */
  _requestNextWave() {
    if (this.state.matchState !== 'intermission') return;
    this._pendingStrikes = [];
    this._spawnWave(this.state.wave + 1);
    this.state.matchState = 'countdown';
    this.state.countdown = SERVER.match.countdownSeconds;
    this._countdownTimer = SERVER.match.countdownSeconds * 1000;
    this._notifyStateChange();
  }

  _resetMatch() {
    if (this.state.matchState !== 'gameover') return;
    this.state.matchState = 'countdown';
    this.state.countdown = SERVER.match.countdownSeconds;
    this._countdownTimer = SERVER.match.countdownSeconds * 1000;
    this._matchEnded = false;
    this.state.winnerId = '';
    this.state.winnerName = '';
    this._pendingStrikes = [];

    // Reset local player
    const me = this.state.players.get(this.sessionId);
    if (me) {
      me.x = 0; me.z = 0; me.rotY = 0;
      me.hp = SERVER.player.maxHp;
      me.score = 0;
      me.anim = 'idle';
      me.blocking = false;
      me.effects.clear();
      me.attackCd = 0;
      me.skillCd = 0;
    }

    // Reset orbs
    const half = SERVER.world.size / 2;
    for (const orb of this.state.orbs) {
      const pos = randomInCircle(this._rng, half - 2);
      orb.x = pos.x;
      orb.z = pos.z;
    }

    // Fresh match = wave 1 (clears every enemy stun/anim override)
    this._spawnWave(1);

    // Reset power-ups
    for (const pu of this.state.powerUps) {
      const pos = randomInCircle(this._rng, half - 2);
      pu.x = pos.x;
      pu.z = pos.z;
      pu.active = true;
    }

    this._notifyStateChange();
  }

  _endMatch(winner) {
    this.state.matchState = 'gameover';
    this.state.winnerId = this.sessionId;
    this.state.winnerName = winner.name;
    this._matchEnded = true;
    this._notifyStateChange();
  }

  _notifyStateChange() {
    for (const fn of this._callbacks.stateChange) fn(this.state);
  }
}
