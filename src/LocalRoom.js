// LocalRoom: a browser-local Colyseus Room replacement.
// Runs the same game logic as GameRoom (movement, orbs, enemies, skills, match lifecycle)
// but entirely in the browser — no server, no WebSocket. Used for GitHub Pages static hosting.

import { WorldState, PlayerState, OrbState, EnemyState, PowerUpState } from './server/schema/StateSchema.js';
import { SERVER } from './server/config.js';
import { stepPlayer } from './server/movement.js';
import { skillFor, resolveSkillHits } from './shared/skills.js';

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

    // Other "fake" players for visual variety (optional — keep it single-player for now)
    // Could add bots here later

    // Orbs
    for (let i = 0; i < SERVER.orb.count; i++) {
      const pos = randomInCircle(this._rng, half - 2);
      this.state.orbs.push(new OrbState(pos.x, pos.z));
    }

    // Enemies
    for (let i = 0; i < SERVER.enemy.count; i++) {
      const pos = randomInCircle(this._rng, half - 2);
      const e = new EnemyState(pos.x, pos.z);
      e.hp = SERVER.enemy.hp;
      this.state.enemies.push(e);
    }

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
    if (this._tickId) cancelAnimationFrame(this._tickId);
    // 4000 = CONSENTED (deliberate leave). GameScene only engages its
    // socket-reconnect machinery for other codes — a local room must never
    // trigger it.
    for (const fn of this._callbacks.leave) fn(4000);
  }

  // --- Game loop -------------------------------------------------------------

  _tick() {
    if (!this._running) return;
    this._tickId = requestAnimationFrame(() => this._tick());

    const now = performance.now();
    const dt = Math.min((now - this._lastTime) / 1000, 0.05); // clamp same as server
    this._lastTime = now;

    this._step(dt);
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

    if (this.state.matchState !== 'playing') return; // gameover

    // --- Local player input + movement ---
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

      // Attack (J) — rejected while blocking (same rule as server). Works while moving.
      if (this._playerInput.attack && me.attackCd <= 0 && !me.blocking) {
        me.attackCd = SERVER.player.attackCooldownMs;
        me.anim = 'attack';
        me.animUntil = performance.now() + SERVER.player.attackAnimMs;
        this._resolveMelee(me);
      }

      // Skill (K) — same gating as the melee (no cast while blocking). Works while moving.
      if (this._playerInput.skill && me.skillCd <= 0 && !me.blocking) {
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

    // --- Enemies: chase nearest player, attack on contact ---
    for (const enemy of this.state.enemies) {
      if (enemy.hp <= 0) continue; // dead, waiting to respawn

      // Find nearest living player
      let target = null;
      let bestDist = Infinity;
      for (const p of players.values()) {
        if (p.hp <= 0) continue;
        const d = Math.hypot(p.x - enemy.x, p.z - enemy.z);
        if (d < bestDist) { bestDist = d; target = p; }
      }

      if (target) {
        // Chase
        const dx = target.x - enemy.x;
        const dz = target.z - enemy.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 1e-3) {
          const moveX = (dx / dist) * SERVER.enemy.speed * dt;
          const moveZ = (dz / dist) * SERVER.enemy.speed * dt;
          enemy.x = clamp(enemy.x + moveX, -half, half);
          enemy.z = clamp(enemy.z + moveZ, -half, half);
          enemy.rotY = Math.atan2(dx, dz);
        }
        enemy.anim = dist > SERVER.enemy.contactRange ? 'run' : 'attack';

        // Contact damage
        if (dist <= SERVER.enemy.contactRange) {
          this._damagePlayer(target, SERVER.enemy.contactDamage, enemy);
          enemy.anim = 'attack';
        }
      } else {
        enemy.anim = 'idle';
      }
    }

    // --- Orbs: pickup ---
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

    // --- Power-ups: pickup ---
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

    // --- Win check (targetScore) ---
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

  _resolveMelee(attacker) {
    const fx = Math.sin(attacker.rotY);
    const fz = Math.cos(attacker.rotY);
    const range = SERVER.player.attackRange;
    const arcCos = SERVER.player.attackArcCos;

    for (const enemy of this.state.enemies) {
      if (enemy.hp <= 0) continue;
      const dx = enemy.x - attacker.x;
      const dz = enemy.z - attacker.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= range && dist > 1e-6) {
        const dot = (dx * fx + dz * fz) / dist;
        if (dot >= arcCos) {
          // Hit: the enemy loses health until it dies, then respawns
          // elsewhere at full HP (same as the server room).
          enemy.hp -= SERVER.player.attackDamage;
          if (enemy.hp <= 0) {
            const pos = randomInCircle(this._rng, SERVER.world.size / 2 - 2);
            enemy.x = pos.x;
            enemy.z = pos.z;
            enemy.hp = SERVER.enemy.hp;
            enemy.anim = 'idle';
            attacker.score += 5; // kill bonus
          } else {
            enemy.anim = 'hit';
          }
        }
      }
    }
  }

  _resolveSkill(caster, skill) {
    const hits = resolveSkillHits(skill, caster, [...this.state.enemies]);
    for (const idx of hits) {
      const enemy = this.state.enemies[idx];
      if (enemy.hp <= 0) continue;
      enemy.hp -= skill.damage;
      if (enemy.hp <= 0) {
        const pos = randomInCircle(this._rng, SERVER.world.size / 2 - 2);
        enemy.x = pos.x;
        enemy.z = pos.z;
        enemy.hp = SERVER.enemy.hp;
        enemy.anim = 'idle';
        caster.score += 5;
      } else {
        enemy.anim = 'hit';
      }
    }
  }

  /** One hit against the local player: BLOCK (frontal) negates it entirely,
   *  the SHIELD power-up absorbs one hit, otherwise HP drops. */
  _damagePlayer(player, amount, source) {
    if (source && this._isBlocked(player, source.x, source.z)) {
      this._emitMessage('blocked', { x: player.x, z: player.z });
      return;
    }
    if (player.effects.has('shield')) {
      player.effects.delete('shield'); // shield blocks one hit
      return;
    }
    const now = performance.now();
    if (player._lastHit && now - player._lastHit < SERVER.player.invulnMs) return;
    player._lastHit = now;
    player.hp = Math.max(0, player.hp - amount);
    if (player.hp <= 0) {
      player.anim = 'hit';
    }
  }

  /** Guarding + the hit source inside the frontal arc (same math as GameRoom). */
  _isBlocked(player, ax, az) {
    if (!player.blocking) return false;
    const dx = ax - player.x;
    const dz = az - player.z;
    const dist = Math.hypot(dx, dz) || 1;
    const dot = (dx * Math.sin(player.rotY) + dz * Math.cos(player.rotY)) / dist;
    return dot >= SERVER.player.blockArcCos;
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
    if (me && me.hp <= 0 && this.state.matchState === 'playing') {
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

  _resetMatch() {
    if (this.state.matchState !== 'gameover') return;
    this.state.matchState = 'countdown';
    this.state.countdown = SERVER.match.countdownSeconds;
    this._countdownTimer = SERVER.match.countdownSeconds * 1000;
    this._matchEnded = false;
    this.state.winnerId = '';
    this.state.winnerName = '';

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

    // Reset enemies
    for (const enemy of this.state.enemies) {
      const pos = randomInCircle(this._rng, half - 2);
      enemy.x = pos.x;
      enemy.z = pos.z;
      enemy.hp = SERVER.enemy.hp;
      enemy.anim = 'idle';
    }

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