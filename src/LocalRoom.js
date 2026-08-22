// LocalRoom: a browser-local Colyseus Room replacement.
// Runs the same game logic as GameRoom (movement, orbs, enemies, skills, wave
// lifecycle, match lifecycle) but entirely in the browser — no server, no
// WebSocket. Used for GitHub Pages static hosting.

import { WorldState, PlayerState, OrbState, EnemyState, PowerUpState, ProjectileState } from './server/schema/StateSchema.js';
import { SERVER } from './server/config.js';
import { stepPlayer } from './server/movement.js';
import { skillFor, resolveSkillHits, classStats } from './shared/skills.js';
// Per-class base stats (Phase 3): hp/speed/melee numbers diverge per class.
const statsOf = (player) => classStats(player.character);
// D1 wave activation lives once in shared/waves.js (P1.3 slice 4 stretch):
// the room injects its seeded LCG circle sampler + anim/stun-map clears.
import { activateWave, waveEnemyHp } from './shared/waves.js';
import { blockedHit, meleeHits, strikeEnemy, strikePlayer } from './shared/combat.js';
import { attackFor } from './shared/classes.js';
// Elite affixes (PRD-elite-affixes.md): same pure table the server room
// consumes — every Nth wave spawns slot 0 as an ELITE, affix chosen by wave
// number so offline matches online without coordination.
import { isEliteWave, affixForWave, applyElite, affixByName, finaleBossFor } from './shared/sim/elites.js';
import { archetypeByName, markArchetypes,
  SHOOTER_PREFERRED_RANGE, SHOOTER_KITE_RANGE, SHOOTER_FIRE_COOLDOWN_MS,
  SHOOTER_KITE_SPEED_MUL, SHOOTER_WINDUP_MS } from './shared/sim/archetypes.js';
import * as orbDrops from './shared/sim/orbDrops.js';
import { pullOrbs } from './shared/sim/magnetPull.js';
// D2 leveling flow lives once in shared/sim (P1.3 slice 1) — same module the
// server room uses; clock/emit hooks below keep offline behavior identical.
// Slice 2 moved D5 enemy-hit + D4 burn DoT (combatBook) and D3 shop effects
// (shopEffects) into shared modules too; slice 3 moved the D6 projectile loop;
// slice 4 completes the set with D7 pause wall + D8 match reset (matchPhases).
import * as leveling from './shared/sim/leveling.js';
import * as combatBook from './shared/sim/combatBook.js';
import * as shopEffects from './shared/sim/shopEffects.js';
import * as projectileLoop from './shared/sim/projectileLoop.js';
import * as matchPhases from './shared/sim/matchPhases.js';
// Kill streaks (PRD-kill-streaks.md): the same pure module GameRoom consumes
// — consecutive credited kills per player, announced ONLY at milestones.
import { newStreakState, registerKill, resetSid, resetAll } from './shared/sim/streaks.js';
import {
         effectiveMaxHp, effectiveSpeedMult, effectiveAttackCdMult, effectiveSkillCdMult,
         effectiveSkill, effectiveMeleeDamage, effectiveRangedDamage, effectivePickupMult,
         aggregateBonuses } from './shared/progression.js';

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
  constructor(options = {}) {
    // ENDLESS WAR (user request): offline play opts into unlimited waves —
    // no targetScore win, no finale victory arc. Death/respawn still applies.
    // Tests construct without the flag and keep legacy semantics.
    this.endless = options?.endless ?? false;
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
    this._projectileId = 0;           // monotonic ID for projectile spawn
    // Phase 4 leveling scratch, migrated to the shared sid-keyed Map shape
    // (P1.3 slice 1) so both rooms feed src/shared/sim/leveling.js the same
    // structure. Single local player — one key each in practice.
    this._deadlines = new Map();      // sid -> ms deadline for upgrade auto-pick
    this._queues = new Map();         // sid -> queued level numbers waiting to show
    this.simLeveling = {              // shared-sim ctx: clock + transport hooks
      players: this.state.players,
      pendingUntil: this._deadlines,
      pendingQueue: this._queues,
      now: () => performance.now(),
      emit: (_sid, type, data) => this._emitMessage(type, data), // fans out, sid dropped
    };
    // D4 burn DoT scratch + shared-sim combat ctx (src/shared/sim/combatBook.js)
    this._burnByProjId = new Map();   // projectile id -> firewave burn def
    this._activeBurns = new Map();    // enemy -> live burn state
    this._volatilePending = new Map(); // dead Volatile elite -> {at, damage, radius}
    // Kill-streak scratch (PRD-kill-streaks.md): sid -> { count, lastAt },
    // mirrors GameRoom.streaks so payloads stay byte-equal across modes.
    this.streaks = newStreakState();
    this._orbCharges = new Map(); // orb -> stored kill-XP (PRD-orb-drops.md)
    this._shooterFireAt = new Map(); // enemy -> ms of next Shooter volley
    this.simCombat = {
      state: this.state,
      half: SERVER.world.size / 2,
      players: this.state.players,
      enemyAnimUntil: this._enemyAnimUntil,
      enemyStunUntil: this._enemyStunUntil,
      burnByProjId: this._burnByProjId,
      activeBurns: this._activeBurns,
      volatilePending: this._volatilePending,
      now: () => performance.now(),
      dropOrb: (x, z, amount) =>
        orbDrops.chargeForKill(this.state.orbs, this._orbCharges, x, z, amount),
      grantXp: (_sid, amount) =>
        leveling.grantXp(this.simLeveling, this.sessionId, amount), // single local player
      damagePlayer: (_sid, victim, amount, srcX, srcZ) =>
        this._damagePlayer(victim, amount, { x: srcX, z: srcZ }),
      // Elite maxHp is not a schema field: recompute from the wave's base HP
      // scaled by the affix — mirrors GameRoom's ctx byte-for-byte.
      eliteMaxHp: (enemy) => Math.ceil(waveEnemyHp(this.state.wave) * (affixByName(enemy.elite)?.hpMul ?? 1)),
    };
    // Shared-sim ctx for the D6 projectile loop (src/shared/sim/projectileLoop.js,
    // P1.3 slice 3): the loop owns stepping/expiry/collision; the room keeps only
    // WHAT a hit does. Burn maps + clock ride along so fireball hits hand off to
    // the D4 register exactly like the old inline call. Player branch unified onto
    // the server rule (owner projectiles can hit OTHER players); the old inverted
    // `!ownerIsPlayer` branch was unreachable dead code offline.
    this.simProjectiles = {
      state: this.state,
      half: SERVER.world.size / 2,
      burnByProjId: this._burnByProjId,
      activeBurns: this._activeBurns,
      now: () => performance.now(),
      onHitEnemy: (proj, enemy) =>
        this._hitEnemy(enemy, proj.damage, proj.x, proj.z, proj.ownerSid),
      onHitPlayer: (proj, _osid, victim) => this._damagePlayer(victim, proj.damage, proj),
    };
    // D3 intermission shop scratch + ctx (src/shared/sim/shopEffects.js).
    // The old boolean _shopPicked migrated to the sid-keyed Map shape the
    // server room already used (P1.3 slice 2).
    this._shopPicks = new Map();
    this.simShop = {
      players: this.state.players,
      state: this.state,
      shopChoices: this._shopPicks,
      emit: (_sid, type, data) => this._emitMessage(type, data), // fans out, sid dropped
    };
    // D7 pause-wall scratch + shared-sim ctx (src/shared/sim/matchPhases.js,
    // P1.3 slice 4): boxes are the mutable ref holders the shared gate
    // mutates. The win-while-paused hook keeps the historical score-only
    // check — the server's full checkWinConditions(0) timed path stays
    // per-side by design (plan section 1 D7 difference 2).
    this.simPhases = {
      state: this.state,
      players: this.state.players,
      pendingUntil: this._deadlines,
      pendingQueue: this._queues,
      pauseBox: { until: 0 },
      intermissionBox: { until: 0 },
      now: () => performance.now(),
      checkAutoPicks: () => leveling.checkAutoPicks(this.simLeveling),
      checkWinWhilePaused: () => {
        if (this.endless) return; // endless war: score never ends offline runs
        if (SERVER.match.targetScore > 0) {
          const me2 = this.state.players.get(this.sessionId);
          if (me2 && me2.hp > 0 && me2.score >= SERVER.match.targetScore) {
            this._endMatch(me2);
          }
        }
      },
      spawnWave: (n) => this._spawnWave(n),
    };
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

  /** Intermission shop delegate — gating + formulas live in shared/sim. */
  _applyShop(choice) {
    return shopEffects.applyShopChoice(this.simShop, this.sessionId, choice).ok;
  }

  send(type, data) {
    if (type === 'input') this._playerInput = data;
    else if (type === 'respawn') this._requestRespawn();
    else if (type === 'playAgain') this._resetMatch();
    else if (type === 'nextWave') this._requestNextWave();
    else if (type === 'chooseUpgrade') this._chooseUpgrade(data?.choice ?? data?.id);
    else if (type === 'chooseShop') this._applyShop(data?.choice ?? data?.id);
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
    me.hp = statsOf(me).hp; // Phase 3: per-class base HP
    me.level = 1;
    me.xp = 0;
    while (me.pendingChoices.length) me.pendingChoices.pop();
    me.upgrades.clear();
    this._deadlines.clear();
    this._queues.clear();
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
    const types = ['speed', 'shield', 'double', 'magnet'];
    for (const type of types) {
      const pos = randomInCircle(this._rng, half - 2);
      const p = new PowerUpState(pos.x, pos.z, type);
      p.active = true;
      this.state.powerUps.push(p);
    }

    // Pause / intermission bookkeeping (mirrors GameRoom pause + intermission
    // boxes; the shared D7 gate mutates these holders)
    this.state.paused = false;
    this.state.intermissionUntil = 0;
    this.simPhases.intermissionBox.until = 0;
    this.simPhases.pauseBox.until = 0;
    this._shopPicks.clear();
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

  /** Activate wave `n` out of the fixed pool — thin delegate over shared
   *  waves.activateWave (P1.3 slice 4 stretch); LCG circle sampler injected.
   *  Elite affixes mirror GameRoom.spawnWave exactly: every Nth wave marks
   *  slot 0 as the ELITE and announces it through the local message channel
   *  (the same path 'blocked' rides) so the client banner needs no new API. */
  _spawnWave(n) {
    const { count } = activateWave(
      this.state.enemies, n, this.state.players,
      () => randomInCircle(this._rng, SERVER.world.size / 2 - 2),
      (enemy) => {
        this._enemyAnimUntil.delete(enemy);
        this._enemyStunUntil.delete(enemy);
        this._volatilePending.delete(enemy);
        enemy.elite = ''; // slots revive clean; re-marked below on elite waves
        enemy.archetype = ''; // archetype tags are re-stamped by markArchetypes
      });
    // FINALE SURGE mirror of GameRoom: full-pool last stand.
    if (SERVER.wave.finaleWave > 0 && n === SERVER.wave.finaleWave &&
        count < this.state.enemies.length) {
      const half = SERVER.world.size / 2;
      for (let i = count; i < this.state.enemies.length; i++) {
        const pos = randomInCircle(this._rng, half - 2);
        const e = this.state.enemies[i];
        e.x = pos.x;
        e.z = pos.z;
        e.hp = waveEnemyHp(n);
        e.anim = 'idle';
      }
    }
    // FINALE BOSS mirror of GameRoom (PRD parity).
    const lboss = finaleBossFor(n, SERVER.wave.finaleWave);
    if (lboss) {
      const lbossAffix = applyElite(this.state.enemies[0], lboss,
        waveEnemyHp(n));
      if (lbossAffix) this._emitMessage('eliteSpawn', { name: lbossAffix.name, boss: true });
    } else if (isEliteWave(n)) {
      const affix = applyElite(this.state.enemies[0], affixForWave(n),
        waveEnemyHp(n));
      if (affix) this._emitMessage('eliteSpawn', { name: affix.name });
    }
    // ENEMY ARCHETYPES: same shared marker as GameRoom -> parity by construction.
    markArchetypes(this.state.enemies, n,
      { liveCount: count,
        eliteWave: isEliteWave(n) || !!lboss }); // boss owns slot 0 too
    this.state.wave = n;
  }

  // -------------------------------------------------------------------------
  // Progression (Phase 4) — the flow is shared with GameRoom in
  // src/shared/sim/leveling.js; methods below are thin delegates kept for
  // callers/tests (local._grantXp, local._hashSeed, local._pendingUntil...).
  // -------------------------------------------------------------------------

  // Scalar deadline API kept for tests/back-compat; the source of truth is
  // the sid-keyed _deadlines map the shared sim consumes.
  get _pendingUntil() { return this._deadlines.get(this.sessionId) ?? null; }
  set _pendingUntil(v) {
    if (v == null) this._deadlines.delete(this.sessionId);
    else this._deadlines.set(this.sessionId, v);
  }

  _hashSeed(sid, level) {
    return leveling.hashSeed(sid, level);
  }

  _grantXp(baseXp) {
    leveling.grantXp(this.simLeveling, this.sessionId, baseXp);
  }

  _maybeLevelUp() {
    leveling.maybeLevelUp(this.simLeveling, this.sessionId);
  }

  _showNextQueued() {
    leveling.showNextQueued(this.simLeveling, this.sessionId);
  }

  _applyUpgrade(id) {
    return leveling.applyUpgrade(this.simLeveling, this.sessionId, id);
  }

  _checkAutoPicks() {
    leveling.checkAutoPicks(this.simLeveling);
  }

  _chooseUpgrade(choice) {
    return leveling.chooseUpgrade(this.simLeveling, this.sessionId, choice);
  }

  _step(dt) {
    const half = SERVER.world.size / 2;
    const players = this.state.players;
    const me = players.get(this.sessionId);

    // Phase 4: auto-pick stalled upgrade cards — must run before pause wall.
    // D7 pause wall (src/shared/sim/matchPhases.js, P1.3 slice 4): the shared
    // gate auto-picks, scans pending cards, arms/caps the global wall by
    // maxPauseMs and extends an active intermission deadline while walled.
    const { dtEff, paused: shouldPause } = matchPhases.pauseGate(this.simPhases, dt);
    // Walled (or a zero-dt tick): skip the world step — the gate already ran
    // the score-target win check so a win cannot deadlock behind a card.
    if (dtEff === 0) return;

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

    // Intermission auto-advance
    if (this.state.matchState === 'intermission' && this.simPhases.intermissionBox.until && performance.now() >= this.simPhases.intermissionBox.until && !shouldPause) {
      this._requestNextWave();
      return;
    }

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
      // Combat rules mirror GameRoom: holding L (block) reduces speed, and
      // attacks/skills cannot be started while blocking (but work while moving).
      me.blocking = !!this._playerInput.block;
      const dirX = inX;
      const dirZ = inZ;
      const speed = (statsOf(me).speed ?? SERVER.player.speed) *
        effectiveSpeedMult(me.upgrades) *
        (me.blocking ? SERVER.player.blockSpeedMult : 1);
      const moved = stepPlayer(me.x, me.z, me.rotY, dirX, dirZ, speed, dt, half);
      me.x = moved.x;
      me.z = moved.z;
      me.rotY = moved.rotY;

      // Attack (J) — playing only, rejected while blocking. The strike is
      // SCHEDULED: damage lands attackImpactMs in, aligned with the swing.
      // Ranged classes (archer/mage/demon) fire a projectile instead.
      if (playing && this._playerInput.attack && me.attackCd <= 0 && !me.blocking) {
        const cd = SERVER.player.attackCooldownMs * effectiveAttackCdMult(me.upgrades);
        me.attackCd = cd;
        me.anim = 'attack';
        me.animUntil = performance.now() + SERVER.player.attackAnimMs;
        const atk = attackFor(me.character);
        if (atk.kind === 'projectile') {
          this._spawnProjectile(me, atk);
        } else {
          this._pendingStrikes.push({ at: performance.now() + SERVER.player.attackImpactMs });
        }
      }

      // Skill (K) — same gating as the melee; skills resolve at cast (their
      // VFX burst reads as the hit moment). Works while moving.
      if (playing && this._playerInput.skill && me.skillCd <= 0 && !me.blocking) {
        const baseSkill = skillFor(me.character);
        const skill = effectiveSkill(baseSkill, me.upgrades);
        me.skillCd = skill.cooldownMs * effectiveSkillCdMult(me.upgrades);
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

    // Burn DoT ticks OUTSIDE the alive-player gate — the ONE sanctioned
    // behavior alignment of P1.3 slice 2 (docs/plans/p1.3-shared-sim-
    // extraction.md section 1, D4): burns keep ticking while the local
    // corpse lies around, exactly as GameRoom's updateEffects always did.
    combatBook.tickBurns(this.simCombat, performance.now());

    // Elite affixes: drain due Volatile fuses (AoE through _damagePlayer, then
    // corpse release) — runs in 'playing' AND 'intermission' like the burns.
    combatBook.tickVolatile(this.simCombat, performance.now());

    // --- Projectiles (playing only) ---------------------------------------
    if (playing) this._updateProjectiles(dt);

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
          const archEntry = enemy.archetype ? archetypeByName(enemy.archetype) : null;
          const targetInvuln = target._lastHit && (now - target._lastHit) < SERVER.player.invulnMs;
          if (archEntry?.name === 'Shooter') {
            // Mirror of GameRoom's shooter branch — identical math, no daily
            // modifier offline. Fires 'arrow' projectiles the shared loop
            // resolves against living players (ownerIsPlayer=false).
            const spdBase = SERVER.enemy.speed *
              (enemy.elite ? affixByName(enemy.elite)?.speedMul ?? 1 : 1) *
              archEntry.speedMul;
            const dxn = dx / dist;
            const dzn = dz / dist;
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
            const half = SERVER.world.size / 2;
            enemy.x = clamp(enemy.x, -half, half);
            enemy.z = clamp(enemy.z, -half, half);
            if (!moved && !animOverride) enemy.anim = 'idle';
            else if (moved && !animOverride) enemy.anim = 'run';
            let vol = this._shooterFireAt.get(enemy);
            if (!vol) vol = { at: now + SHOOTER_FIRE_COOLDOWN_MS, told: false };
            if (dist <= SHOOTER_PREFERRED_RANGE + 1) {
              // WINDUP TELEGRAPH mirror of GameRoom.
              if (!vol.told && now >= vol.at - SHOOTER_WINDUP_MS) {
                vol.told = true;
                if (!animOverride) enemy.anim = 'attack';
                this._enemyAnimUntil.set(enemy, now + SHOOTER_WINDUP_MS);
              }
              if (now >= vol.at) {
                const proj = new ProjectileState(this._projectileId++, '', 'arrow',
                  enemy.x, enemy.z, dxn, dzn);
                proj.speed = SERVER.projectile.arrowSpeed;
                proj.damage = SERVER.enemy.shotDamage;
                proj.ttl = SERVER.projectile.arrowTtlMs;
                proj.ownerIsPlayer = false;
                this.state.projectiles.push(proj);
                this._enemyAnimUntil.set(enemy, now + SERVER.enemy.attackAnimMs);
                enemy.anim = 'attack';
                vol = { at: now + SHOOTER_FIRE_COOLDOWN_MS, told: false };
              }
            }
            this._shooterFireAt.set(enemy, vol);
          } else if (dist > SERVER.enemy.contactRange) {
            // Elite affixes add their speedMul (Swift +60%) — same math as
            // GameRoom's chase (no daily modifier exists offline).
            if (dist > 1e-3) {
              const spd = SERVER.enemy.speed *
                (enemy.elite ? affixByName(enemy.elite)?.speedMul ?? 1 : 1) *
                (enemy.archetype ? archetypeByName(enemy.archetype)?.speedMul ?? 1 : 1);
              enemy.x = clamp(enemy.x + (dx / dist) * spd * dt, -half, half);
              enemy.z = clamp(enemy.z + (dz / dist) * spd * dt, -half, half);
            }
            if (!animOverride) enemy.anim = 'run';
          } else if (!targetInvuln) {
            // Contact damage — punch anim swings even when the hit is
            // blocked (same feedback as the server room).
            this._enemyAnimUntil.set(enemy, now + SERVER.enemy.attackAnimMs);
            enemy.anim = 'attack';
            const victimHp = target.hp;
            if (this._damagePlayer(target, SERVER.enemy.contactDamage, enemy)) {
              // Vampiric elites siphon back a share of the HP they drained.
              combatBook.applyVampiricHeal(this.simCombat, enemy, victimHp - target.hp);
            }
          } else if (!animOverride) {
            enemy.anim = 'idle'; // adjacent but the target is invulnerable
          }
        } else if (!animOverride) {
          enemy.anim = 'idle';
        }
      }

      // Wave cleared -> intermission (auto-advances after intermissionMs)
      if (this.state.enemies.length > 0 && alive === 0) {
        this.state.matchState = 'intermission';
        this._pendingStrikes = [];
        this.state.projectiles.clear();
        this.simPhases.intermissionBox.until = performance.now() + (SERVER.wave?.intermissionMs ?? 8000);
        this.state.intermissionUntil = this.simPhases.intermissionBox.until;
        this._shopPicks.clear();
        this._notifyStateChange();
        return;
      }
    }

    // --- Magnet: same pre-pull as GameRoom (PRD-magnet.md parity) ---------
    const magnetHolders = [];
    for (const pl of players.values()) {
      if (pl.hp > 0 && pl.effects.has('magnet')) magnetHolders.push(pl);
    }
    if (magnetHolders.length > 0) {
      const mc = SERVER.powerUps.magnet;
      pullOrbs(this.state.orbs, magnetHolders, mc.pullRadius, mc.pullSpeed, dt);
    }
    // --- Orbs: pickup (playing + intermission) ----------------------------
    for (const orb of this.state.orbs) {
      for (const p of players.values()) {
        if (p.hp <= 0) continue;
        const mult = effectivePickupMult(p.upgrades);
        const d = Math.hypot(p.x - orb.x, p.z - orb.z);
        if (d <= (SERVER.orb.radius * mult) + SERVER.player.radius) {
          let score = SERVER.orb.score;
          if (p.effects.has('double')) score *= 2;
          p.score += score;
          if (p === this.state.players.get(this.sessionId)) {
            this._grantXp(SERVER.progression?.xpPerOrb ?? 20);
            const lcharge = orbDrops.drainCharge(this._orbCharges, orb);
            if (lcharge > 0) this._grantXp(lcharge);
          }
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
        const mult = effectivePickupMult(p.upgrades);
        const d = Math.hypot(p.x - pu.x, p.z - pu.z);
        if (d <= (SERVER.powerUps.radius * mult) + SERVER.player.radius) {
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
    if (!this.endless && SERVER.match.targetScore > 0 && !this._matchEnded) {
      for (const p of players.values()) {
        if (p.score >= SERVER.match.targetScore) {
          this._endMatch(p);
          break;
        }
      }
    }

    this._notifyStateChange();
  }

  /** Kill-streak bookkeeping (PRD-kill-streaks.md) — exact mirror of
   *  GameRoom.creditStreak on the local message channel: called after every
   *  enemy death credited to `sid`, announces ONLY at MILESTONES counts with
   *  an identical payload shape { sid, name, count, label }. */
  _creditStreak(sid, now = performance.now()) {
    const ms = registerKill(this.streaks, sid, now);
    if (!ms) return;
    this._emitMessage('killStreak', {
      sid,
      name: this.state.players.get(sid)?.name ?? '',
      count: this.streaks.get(sid)?.count ?? 0,
      label: ms,
    });
  }

  /** Shared enemy-hit resolution (thin delegate over
   *  shared/sim/combatBook.resolveEnemyHit, sid-based like GameRoom):
   *  knockback, HIT-STUN on survivors, stay-dead + kill score + XP on kills.
   *  The PlayerState fallback exists only for legacy callers that hand us the
   *  player object directly. */
  _hitEnemy(enemy, damage, srcX, srcZ, killer) {
    const killerSid = typeof killer === 'string'
      ? killer
      : (killer && killer === this.state.players.get(this.sessionId)) ? this.sessionId : null;
    const res = combatBook.resolveEnemyHit(
      this.simCombat, enemy, damage, srcX, srcZ, killerSid);
    if (res.killed && killerSid != null) this._creditStreak(killerSid);
    return res.killed;
  }

  _resolveMelee(attacker) {
    // Shared arc math: which enemies this swing covers (dead ones skipped).
    const dmg = effectiveMeleeDamage(attacker.character, attacker.upgrades);
    for (const i of meleeHits(attacker, this.state.enemies, SERVER.player)) {
      const enemy = this.state.enemies[i];
      // Hit: the enemy stays down at 0 HP until the next wave revives
      // its slot (killed enemies no longer teleport-respawn).
      this._hitEnemy(enemy, dmg, attacker.x, attacker.z, this.sessionId);
    }
  }

  _resolveSkill(caster, skill) {
    const enemies = [...this.state.enemies];
    const targets = enemies.map((e) => ({ x: e.x, z: e.z }));
    const result = resolveSkillHits(skill, caster, targets);

    // Bash: move the caster to the landing position
    if (result.movement) {
      const half = SERVER.world.size / 2;
      const nx = Math.max(-half, Math.min(half, caster.x + result.movement.dx));
      const nz = Math.max(-half, Math.min(half, caster.z + result.movement.dz));
      caster.x = nx;
      caster.z = nz;
    }

    // Direct hits (bash, chainlight, legacy aoe/cone). Bash carries its own
    // knockback + 1s stun (mirror of GameRoom.castSkill).
    if (result.hits.length > 0) {
      const now = performance.now();
      for (const i of result.hits) {
        const enemy = enemies[i];
        if (!enemy || enemy.hp <= 0) continue;
        const dmg = result.damagePerHit ? result.damagePerHit[result.hits.indexOf(i)] : skill.damage;
        if (skill.kind === 'bash') {
          // Bulwark (knockbackImmune): takes the damage, never the shove.
          const { hit, killed } = strikeEnemy(enemy, dmg, caster.x, caster.z,
            combatBook.knockbackAgainst(enemy, skill.knockback), SERVER.world.size / 2);
          if (hit) {
            if (killed) {
              if (caster) {
                caster.score += SERVER.enemy.killScore;
                if (caster === this.state.players.get(this.sessionId)) this._grantXp(SERVER.progression?.xpPerKill ?? 30);
              }
              combatBook.onEliteKill(this.simCombat, enemy, this.sessionId); // elite burst + Volatile fuse
              this._creditStreak(this.sessionId); // bash kills feed streaks too
            } else {
              enemy.anim = 'hit';
              this._enemyAnimUntil.set(enemy, now + SERVER.enemy.hitAnimMs);
              this._enemyStunUntil.set(enemy, now + (skill.stunDurationMs || 1000));
            }
          }
        } else {
          this._hitEnemy(enemy, dmg, caster.x, caster.z, this.sessionId);
        }
      }
    }

    // Projectile-spawning skills (multishot, firewave)
    if (result.projectiles) {
      for (const pDef of result.projectiles) {
        const proj = new ProjectileState(
          this._projectileId++, this._myPlayerId, pDef.projKind,
          caster.x, caster.z, pDef.dirX, pDef.dirZ
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
  }

  /**
   * Spawn a projectile from the player's position in the facing direction.
   * Must be a ProjectileState instance — state.projectiles is a typed
   * ArraySchema, and pushing a plain object throws EncodeSchemaError
   * (confirmed: offline sim crashed on any ranged attack).
   */
  _spawnProjectile(player, atkDef) {
    const fx = Math.sin(player.rotY);
    const fz = Math.cos(player.rotY);
    const proj = new ProjectileState(
      this._projectileId++, this._myPlayerId, atkDef.projKind,
      player.x, player.z, fx, fz
    );
    proj.speed = atkDef.speed;
    proj.damage = effectiveRangedDamage(player.character, player.upgrades);
    proj.ttl = atkDef.ttlMs;
    proj.ownerIsPlayer = true;
    this.state.projectiles.push(proj);
  }

  /**
   * Tick every live projectile: step forward, check collision with enemies
   * and the local player (PvP), remove on hit or TTL/bounds expiry. Delegates
   * to the shared D6 loop (src/shared/sim/projectileLoop.js, P1.3 slice 3);
   * hit resolution stays room-side via the simProjectiles hooks.
   */
  _updateProjectiles(dt) {
    projectileLoop.stepProjectiles(this.simProjectiles, dt);
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
    // Hit react: brief 'hit' anim override so the player flinches.
    player.anim = 'hit';
    player.animUntil = performance.now() + 300;
    if (player.hp <= 0) {
      player.anim = 'hit';
      // Kill-streaks (PRD-kill-streaks.md): death drops the victim's streak.
      resetSid(this.streaks, this.sessionId);
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
      me.hp = effectiveMaxHp(me.character, me.upgrades);
      me.x = 0;
      me.z = 0;
      me.rotY = 0;
      me.anim = 'idle';
      me.blocking = false;
      me.effects.clear();
      this._notifyStateChange();
    }
  }

  /** Click on the wave-cleared popup: next wave + countdown (also auto-advance). */
   _requestNextWave() {
    if (this.state.matchState !== 'intermission') return;
    // WAVE FINALE mirror of GameRoom.startNextWave (PRD-wave-finale.md).
    if (!this.endless && SERVER.wave.finaleWave > 0 &&
        this.state.wave + 1 > SERVER.wave.finaleWave) {
      this.state.victory = true;
      this.state.matchState = 'gameover';
      this.state.countdown = 0;
      this._matchEnded = true;
      this._notifyStateChange();
      return;
    }
    this._pendingStrikes = [];
    this.state.projectiles.clear();
    this.simPhases.intermissionBox.until = 0;
    this.state.intermissionUntil = 0;
    this._shopPicks.clear();
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
    // Player/world reset is shared (src/shared/sim/matchPhases.js, P1.3
    // slice 4): winner + projectiles cleared (the projectile clear was always
    // here — GameRoom now aligns), local player back to origin/base stats,
    // orbs/power-ups reseeded, wave 1 reactivated.
    matchPhases.resetMatchState(this.simPhases, {
      samplePos: (kind) =>
        kind === 'player'
          ? { x: 0, z: 0, rotY: 0 }
          : randomInCircle(this._rng, SERVER.world.size / 2 - 2),
      onResetTransient: () => { this._pendingStrikes = []; this._volatilePending.clear(); },
    });
    resetAll(this.streaks); // fresh match = fresh streaks (PRD-kill-streaks.md)
    orbDrops.clearCharges(this._orbCharges); // fresh match = plain orbs
    this._shooterFireAt.clear(); // fresh match = synced volleys restart
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
