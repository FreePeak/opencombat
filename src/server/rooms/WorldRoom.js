// WorldRoom — infinite chunked open world (Phase 6).
// Chunk size 32, seeded, 3 biomes, active-chunk radius 2, level-scaled spawns,
// persistence per-player JSON debounced 2s.

import { Room, CloseCode } from 'colyseus';
import { WorldState, PlayerState, OrbState, PowerUpState, EnemyState, ProjectileState } from '../schema/StateSchema.js';
import { SERVER } from '../config.js';
import { log, warn } from '../log.js';
import { takeToken, normalizeIp } from '../ratelimit.js';
import { stepPlayer } from '../movement.js';
import { skillFor, resolveSkillHits, classStats } from '../../shared/skills.js';
const statsOf = (player) => classStats(player.character);
import { blockedHit, meleeHits, strikeEnemy, strikePlayer } from '../../shared/combat.js';
import { attackFor } from '../../shared/classes.js';
import { stepProjectile, projectileExpired, projectileHitsTarget } from '../../shared/projectiles.js';
import { xpForLevel, rollUpgrades, getUpgrade, aggregateBonuses,
         effectiveMaxHp, effectiveSpeedMult, effectiveAttackCdMult, effectiveSkillCdMult,
         effectiveSkill, effectiveMeleeDamage, effectiveRangedDamage, effectiveXp, effectivePickupMult,
         AUTO_PICK_MS } from '../../shared/progression.js';
import { generateChunk, activeChunksForPos, CHUNK_SIZE, enemiesForLevel } from '../../shared/worldgen.js';
import { loadPlayer, savePlayerDebounced } from '../persistence.js';
// Presence panel (PRD-presence.md): cross-room live population registry.
import { registerPresence, removePresence } from '../presence.js';

function nameHash(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

export default class WorldRoom extends Room {
  maxClients = SERVER.match?.maxClients ?? 12;
  static instances = new Set();
  static stats = { lastTickMs: 0, inputTimes: [] };

  onCreate(options = {}) {
    WorldRoom.instances.add(this);
    this.autoDispose = false;
    this.setState(new WorldState());
    // Open world is always playing, no lobby/countdown
    this.state.matchState = 'playing';
    this.state.countdown = 0;
    this.state.arenaMode = 'openworld';
    this.state.wave = 1;

    this.worldSeed = options.seed ?? SERVER.world?.seed ?? 1337;
    this.chunkRadius = SERVER.world?.chunkRadius ?? 2;
    // Large half for open world (effectively unbounded, but clamp to avoid float overflow)
    this.half = 5000;
    this.lastActiveAt = Date.now();

    // Per-session scratch
    this.inputs = new Map();
    this.attackAt = new Map();
    this.skillAt = new Map();
    this.invulnUntil = new Map();
    this.animUntil = new Map();
    this.msgTimes = new Map();
    this.graceTimers = new Map();
    this.enemyAnimUntil = new Map();
    this.enemyStunUntil = new Map();
    this.pendingMelee = [];
    this.powerUpTimers = new Map();
    this._projectileId = 0;
    this.pendingUntil = new Map();
    this.pendingQueue = new Map();

    // Chunk tracking: key -> chunkData, sid -> Set<key>
    this.loadedChunks = new Map();
    this.playerChunks = new Map();

    // Fixed pools but larger for open world: orbs/enemies/powerUps are global but
    // we keep them and respawn within active chunks
    this.spawnOrbs();
    this.spawnEnemies();
    this.spawnPowerUps();

    this.onMessage('input', (client, msg) => this.onInput(client, msg));
    this.onMessage('respawn', (client) => this.onRespawn(client));
    this.onMessage('chooseUpgrade', (client, msg) => this.onChooseUpgrade(client, msg));

    this.lastTickAt = Date.now();
    this.clock.setInterval(() => {
      const now = Date.now();
      const dt = Math.min((now - this.lastTickAt) / 1000, 0.25);
      this.lastTickAt = now;
      const t0 = performance.now();
      this.update(dt);
      WorldRoom.stats.lastTickMs = performance.now() - t0;
    }, SERVER.tickMs);

    this.logEvent('world_create', { seed: this.worldSeed, chunkRadius: this.chunkRadius });
  }

  logEvent(event, fields = {}) { log(event, { roomId: this.roomId, ...fields }); }
  warnEvent(event, fields = {}) { warn(event, { roomId: this.roomId, ...fields }); }

  sanitizeName(raw) {
    const name = String(raw ?? '').trim().slice(0, 16);
    return name || 'player';
  }
  sanitizeCharacter(raw) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(SERVER.characters.count - 1, n));
  }

  // Random position inside active chunks (for orbs/powerUps/enemies)
  randomPosInActiveChunks() {
    if (this.loadedChunks.size === 0) {
      const m = 20;
      return { x: -m + Math.random() * m * 2, z: -m + Math.random() * m * 2 };
    }
    const keys = [...this.loadedChunks.keys()];
    const key = keys[Math.floor(Math.random() * keys.length)];
    const chunk = this.loadedChunks.get(key);
    const pad = 2;
    const x = chunk.x + pad + Math.random() * (CHUNK_SIZE - pad * 2);
    const z = chunk.z + pad + Math.random() * (CHUNK_SIZE - pad * 2);
    return { x, z };
  }

  randomPos() {
    // For initial spawns before chunks loaded, use small arena around origin
    const m = this.half - 1.5;
    // Clamp to small radius for initial world so players don't scatter 5000 units
    const small = 30;
    return { x: -small + Math.random() * small * 2, z: -small + Math.random() * small * 2 };
  }

  spawnOrbs() {
    for (let i = 0; i < SERVER.orb.count; i++) {
      const p = this.randomPos();
      this.state.orbs.push(new OrbState(p.x, p.z));
    }
  }

  spawnEnemies() {
    for (let i = 0; i < SERVER.enemy.pool; i++) {
      this.state.enemies.push(new EnemyState(0, 0));
    }
    // Initially spawn based on average player level 1
    this.respawnWorldEnemies(1);
  }

  respawnWorldEnemies(avgLevel = 1) {
    const count = Math.min(enemiesForLevel(avgLevel), SERVER.enemy.pool);
    const hp = 2 + Math.floor((avgLevel - 1) / 2);
    const players = [...this.state.players.values()].filter((p) => p.hp > 0);
    this.state.enemies.forEach((enemy, i) => {
      this.enemyAnimUntil.delete(enemy);
      this.enemyStunUntil.delete(enemy);
      if (i < count) {
        // Try to place inside active chunks near players, else random
        let pos;
        if (players.length > 0 && this.loadedChunks.size > 0) {
          pos = this.randomPosInActiveChunks();
          // Ensure not too close to players
          let best = pos;
          let bestDist = 0;
          for (let attempt = 0; attempt < 4; attempt++) {
            const cand = this.randomPosInActiveChunks();
            let minD = Infinity;
            for (const pl of players) minD = Math.min(minD, Math.hypot(cand.x - pl.x, cand.z - pl.z));
            if (minD > bestDist) { bestDist = minD; best = cand; }
          }
          pos = best;
        } else {
          pos = this.randomPos();
        }
        enemy.x = pos.x;
        enemy.z = pos.z;
        enemy.hp = Math.min(hp, SERVER.enemy.hpMax);
        enemy.anim = 'idle';
      } else {
        enemy.hp = 0;
      }
    });
    this.state.wave = avgLevel;
  }

  spawnPowerUps() {
    const types = Object.keys(SERVER.powerUps).filter((k) => ['speed', 'shield', 'double'].includes(k));
    for (let i = 0; i < SERVER.powerUps.count; i++) {
      const p = this.randomPos();
      this.state.powerUps.push(new PowerUpState(p.x, p.z, types[i % types.length]));
    }
  }

  onAuth(_client, _options, authContext) {
    const ip = normalizeIp(authContext?.ip);
    if (!takeToken(ip)) {
      this.warnEvent('join_rate_limited', { ip });
      throw new Error('too many join attempts — wait a few seconds and try again');
    }
    return true;
  }

  onJoin(client, options = {}) {
    let player = this.state.players.get(client.sessionId);
    const isReconnect = !!player;
    if (player) {
      this.logEvent('player_reconnect', { sid: client.sessionId, name: player.name });
    } else {
      const name = this.sanitizeName(options.name);
      const character = this.sanitizeCharacter(options.character);
      // Persistence: try to load per-player JSON
      const saved = loadPlayer(name);
      const p = this.randomPos();
      player = new PlayerState(p.x, p.z);
      player.name = name;
      player.character = character;
      player.color = SERVER.colors[nameHash(name) % SERVER.colors.length];
      if (saved) {
        player.level = Math.max(1, Math.floor(saved.level ?? 1));
        player.xp = Math.max(0, saved.xp ?? 0);
        player.score = saved.score ?? 0;
        // Restore upgrades
        player.upgrades.clear();
        if (saved.upgrades) {
          for (const [k, v] of Object.entries(saved.upgrades)) {
            player.upgrades.set(k, v);
          }
        }
        // Pending choices
        while (player.pendingChoices.length) player.pendingChoices.pop();
        if (Array.isArray(saved.pendingChoices)) {
          for (const id of saved.pendingChoices) player.pendingChoices.push(id);
        }
        player.hp = effectiveMaxHp(player.character, player.upgrades);
        this.logEvent('player_load', { sid: client.sessionId, name, level: player.level, xp: player.xp });
      } else {
        player.hp = statsOf(player).hp;
        player.level = 1;
        player.xp = 0;
        while (player.pendingChoices.length) player.pendingChoices.pop();
        player.upgrades.clear();
      }
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
    if (!isReconnect) {
      // Initialize chunk tracking for this player
      this.playerChunks.set(client.sessionId, new Set());
      this.updatePlayerChunks(client.sessionId);
    }
    // No countdown in open world; ensure playing
    this.state.matchState = 'playing';
    // Presence panel (PRD-presence.md): one registry row per connected player.
    registerPresence(client.sessionId, { name: player.name, mode: 'world', roomId: this.roomId });
  }

  onLeave(client, code = CloseCode.CONSENTED) {
    const sid = client.sessionId;
    removePresence(sid); // connection gone -> off /api/players (grace reconnect re-registers)
    // Persist immediately on leave (flush)
    const player = this.state.players.get(sid);
    if (player) {
      this.persistPlayer(sid, player);
    }
    if (code === CloseCode.CONSENTED) {
      this.removePlayer(sid);
      return;
    }
    if (!this.graceTimers.has(sid)) {
      const p = this.allowReconnection(client, SERVER.match.reconnectGraceMs / 1000);
      if (p?.catch) p.catch(() => this.removePlayer(sid));
      const timer = setTimeout(() => this.removePlayer(sid), SERVER.match.reconnectGraceMs);
      this.graceTimers.set(sid, timer);
      this.logEvent('player_drop_grace', { sid, graceMs: SERVER.match.reconnectGraceMs });
    }
  }

  removePlayer(sid) {
    const player = this.state.players.get(sid);
    if (player) this.persistPlayer(sid, player);
    this.state.players.delete(sid);
    this.inputs.delete(sid);
    this.attackAt.delete(sid);
    this.invulnUntil.delete(sid);
    this.animUntil.delete(sid);
    this.msgTimes.delete(sid);
    this.pendingUntil.delete(sid);
    this.pendingQueue?.delete(sid);
    this.playerChunks.delete(sid);
    const t = this.graceTimers.get(sid);
    if (t) { clearTimeout(t); this.graceTimers.delete(sid); }
    this.logEvent('player_remove', { sid, players: this.state.players.size });
    // Unload chunks no longer needed by any player
    this.recomputeLoadedChunks();
  }

  onDispose() {
    for (const sid of this.state.players.keys()) removePresence(sid); // error-path cleanup
    // Flush all pending saves
    for (const [sid, player] of this.state.players) {
      this.persistPlayer(sid, player);
    }
    WorldRoom.instances.delete(this);
    this.logEvent('world_dispose');
  }

  persistPlayer(sid, player) {
    if (!player) return;
    const data = {
      name: player.name,
      character: player.character,
      level: player.level,
      xp: player.xp,
      score: player.score,
      upgrades: Object.fromEntries(player.upgrades.entries()),
      pendingChoices: [...player.pendingChoices],
    };
    savePlayerDebounced(player.name, data);
  }

  // --- Chunk management ---
  chunkKeyForPos(x, z) {
    const { cx, cz } = { cx: Math.floor(x / CHUNK_SIZE), cz: Math.floor(z / CHUNK_SIZE) };
    return `${cx},${cz}`;
  }

  updatePlayerChunks(sid) {
    const player = this.state.players.get(sid);
    if (!player) return;
    const needed = new Set(activeChunksForPos(player.x, player.z, this.chunkRadius, this.worldSeed));
    const prev = this.playerChunks.get(sid) || new Set();
    // Update player's chunk set
    this.playerChunks.set(sid, needed);
    // Recompute global loaded chunks as union of all players' needed
    this.recomputeLoadedChunks();
    // Could send delta to client: which chunks to load/unload
    const toLoad = [...needed].filter((k) => !prev.has(k));
    if (toLoad.length > 0) {
      const client = this.clients.find((c) => c.sessionId === sid);
      if (client) {
        // Send chunk data for newly visible chunks (biome + props)
        const chunks = toLoad.map((key) => {
          const [cx, cz] = key.split(',').map(Number);
          return generateChunk(cx, cz, this.worldSeed);
        });
        client.send('chunksLoad', { chunks });
      }
    }
  }

  recomputeLoadedChunks() {
    const neededUnion = new Set();
    for (const set of this.playerChunks.values()) {
      for (const k of set) neededUnion.add(k);
    }
    // Load new
    for (const key of neededUnion) {
      if (!this.loadedChunks.has(key)) {
        const [cx, cz] = key.split(',').map(Number);
        const chunk = generateChunk(cx, cz, this.worldSeed);
        this.loadedChunks.set(key, chunk);
        this.logEvent('chunk_load', { key, biome: chunk.biome });
      }
    }
    // Unload old
    for (const key of [...this.loadedChunks.keys()]) {
      if (!neededUnion.has(key)) {
        this.loadedChunks.delete(key);
        this.logEvent('chunk_unload', { key });
      }
    }
    this.state.wave = this.loadedChunks.size; // repurpose wave as loaded chunk count for debug
  }

  // --- Progression (same as GameRoom) ---
  grantXp(sid, baseXp) {
    const player = this.state.players.get(sid);
    if (!player) return;
    const amt = effectiveXp(baseXp, player.upgrades);
    if (amt <= 0) return;
    player.xp += amt;
    this.logEvent('xp_gain', { sid, amount: amt, total: player.xp });
    this.persistPlayer(sid, player);
    this.maybeLevelUp(sid);
  }

  maybeLevelUp(sid) {
    const player = this.state.players.get(sid);
    if (!player) return;
    if (!this.pendingQueue) this.pendingQueue = new Map();
    let queue = this.pendingQueue.get(sid);
    if (!queue) { queue = []; this.pendingQueue.set(sid, queue); }
    while (player.xp >= xpForLevel(player.level + 1)) {
      const nextLevel = player.level + 1;
      if (player.pendingChoices.length > 0 || queue.length > 0) {
        player.level = nextLevel;
        queue.push(nextLevel);
        this.logEvent('level_queued', { sid, level: player.level, queued: queue.length });
        this.persistPlayer(sid, player);
        continue;
      }
      player.level = nextLevel;
      const seed = this.hashSeed(sid, player.level);
      const picks = rollUpgrades(seed, player.character, player.upgrades);
      while (player.pendingChoices.length) player.pendingChoices.pop();
      for (const id of picks) player.pendingChoices.push(id);
      const ms = SERVER.progression?.autoPickMs ?? AUTO_PICK_MS;
      this.pendingUntil.set(sid, Date.now() + ms);
      this.logEvent('level_up', { sid, level: player.level, choices: picks });
      this.persistPlayer(sid, player);
      const client = this.clients.find((c) => c.sessionId === sid);
      client?.send('levelUp', { level: player.level, choices: picks });
    }
  }

  showNextQueued(sid) {
    const player = this.state.players.get(sid);
    if (!player) return;
    const queue = this.pendingQueue?.get(sid);
    if (!queue || queue.length === 0) return;
    const lvl = queue.shift();
    const seed = this.hashSeed(sid, lvl);
    const picks = rollUpgrades(seed, player.character, player.upgrades);
    while (player.pendingChoices.length) player.pendingChoices.pop();
    for (const id of picks) player.pendingChoices.push(id);
    const ms = SERVER.progression?.autoPickMs ?? AUTO_PICK_MS;
    this.pendingUntil.set(sid, Date.now() + ms);
    this.logEvent('level_up_queued_show', { sid, level: lvl, choices: picks });
    this.persistPlayer(sid, player);
    const client = this.clients.find((c) => c.sessionId === sid);
    client?.send('levelUp', { level: lvl, choices: picks });
  }

  hashSeed(sid, level) {
    let h = 0;
    const s = sid + ':' + level;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h || 1;
  }

  applyUpgrade(player, sid, upgradeId) {
    const def = getUpgrade(upgradeId);
    if (!def) return false;
    const cur = player.upgrades.get(upgradeId) || 0;
    if (cur >= (def.maxStacks ?? 99)) return false;
    player.upgrades.set(upgradeId, cur + 1);
    if (upgradeId === 'vitality') {
      const maxHp = effectiveMaxHp(player.character, player.upgrades);
      player.hp = Math.min(maxHp, player.hp + 30);
    }
    this.logEvent('upgrade_pick', { sid, upgradeId, stacks: cur + 1, level: player.level });
    this.persistPlayer(sid, player);
    return true;
  }

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
      const queue = this.pendingQueue?.get(sid);
      if (queue && queue.length > 0) this.showNextQueued(sid);
      else this.maybeLevelUp(sid);
    }
  }

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

  // --- Core simulation ---
  randomWorldPos() {
    return this.randomPosInActiveChunks();
  }

  isBlocked(player, ax, az) {
    return blockedHit(player, ax, az, SERVER.player.blockArcCos);
  }

  notifyBlocked(sid, victim) {
    const client = this.clients.find((c) => c.sessionId === sid);
    client?.send('blocked', { x: victim.x, z: victim.z });
    this.logEvent('player_blocked', { sid });
  }

  damagePlayer(sid, victim, amount, srcX, srcZ) {
    const now = Date.now();
    if (now < this.invulnUntil.get(sid)) return false;
    if (this.state.matchState !== 'playing') return false;
    if (this.isBlocked(victim, srcX, srcZ)) {
      this.notifyBlocked(sid, victim);
      return false;
    }
    if (victim.effects.has('shield')) {
      victim.effects.delete('shield');
      this.logEvent('shield_absorb', { sid });
      return false;
    }
    this.invulnUntil.set(sid, now + SERVER.player.invulnMs);
    strikePlayer(victim, amount, srcX, srcZ, SERVER.player.knockback * 0.15, this.half);
    victim.anim = 'hit';
    this.animUntil.set(sid, now + 300);
    return true;
  }

  hitEnemy(enemy, damage, srcX, srcZ, killer) {
    const { hit, killed } = strikeEnemy(enemy, damage, srcX, srcZ, SERVER.enemy.hitKnockback, this.half);
    if (!hit) return false;
    if (killed) {
      if (killer) {
        killer.score += SERVER.enemy.killScore;
        const sid = [...this.state.players.entries()].find(([, p]) => p === killer)?.[0];
        if (sid) this.grantXp(sid, SERVER.progression?.xpPerKill ?? 30);
      }
      this.logEvent('enemy_killed', { by: killer?.name });
      // Respawn this enemy after a short delay in an active chunk
      setTimeout(() => {
        if (enemy.hp !== 0) return; // already respawned elsewhere
        const avgLevel = this.avgPlayerLevel();
        const hp = 2 + Math.floor((avgLevel - 1) / 2);
        const pos = this.randomPosInActiveChunks();
        enemy.x = pos.x;
        enemy.z = pos.z;
        enemy.hp = Math.min(hp, SERVER.enemy.hpMax);
        enemy.anim = 'idle';
      }, 5000);
      return true;
    }
    const now = Date.now();
    enemy.anim = 'hit';
    this.enemyAnimUntil.set(enemy, now + SERVER.enemy.hitAnimMs);
    this.enemyStunUntil.set(enemy, now + SERVER.enemy.hitStunMs);
    return false;
  }

  avgPlayerLevel() {
    let sum = 0, n = 0;
    for (const p of this.state.players.values()) { sum += p.level; n++; }
    return n ? Math.round(sum / n) : 1;
  }

  melee(sid) {
    const player = this.state.players.get(sid);
    if (!player || player.hp <= 0) return;
    player.anim = 'attack';
    const cfg = SERVER.player;
    const dmg = effectiveMeleeDamage(player.character, player.upgrades);
    const pvpDmg = classStats(player.character).meleePvpDamage ?? cfg.attackPvpDamage;
    for (const i of meleeHits(player, [...this.state.enemies], cfg)) {
      const enemy = this.state.enemies[i];
      this.hitEnemy(enemy, dmg, player.x, player.z, player);
    }
    for (const [osid, victim] of this.state.players) {
      if (osid === sid || victim.hp <= 0) continue;
      if (meleeHits(player, [victim], cfg).length) {
        this.damagePlayer(osid, victim, pvpDmg, player.x, player.z);
      }
    }
  }

  castSkill(sid) {
    const state = this.state;
    const player = state.players.get(sid);
    if (!player || player.hp <= 0) return;
    const baseDef = skillFor(player.character);
    const def = effectiveSkill(baseDef, player.upgrades);
    const now = Date.now();
    if (now < this.skillAt.get(sid)) return;
    const skillCd = def.cooldownMs * effectiveSkillCdMult(player.upgrades);
    this.skillAt.set(sid, now + skillCd);
    this.animUntil.set(sid, now + def.animMs);
    player.anim = 'skill';
    const targets = [...state.enemies].map((e) => ({ x: e.x, z: e.z }));
    const result = resolveSkillHits(def, player, targets);
    const stats = classStats(player.character);
    const skillPvpDmg = stats.skillPvpDamage || 10;
    const pvpVictims = [];
    for (const [osid, victim] of state.players) {
      if (osid === sid || victim.hp <= 0) continue;
      const pResult = resolveSkillHits(def, player, [{ x: victim.x, z: victim.z }]);
      if (pResult.hits.length) pvpVictims.push(osid);
    }
    if (result.movement) {
      const nx = Math.max(-this.half, Math.min(this.half, player.x + result.movement.dx));
      const nz = Math.max(-this.half, Math.min(this.half, player.z + result.movement.dz));
      player.x = nx;
      player.z = nz;
    }
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
              this.logEvent('enemy_killed', { by: player.name });
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
    if (result.projectiles) {
      for (const pDef of result.projectiles) {
        const proj = new ProjectileState(this._projectileId++, sid, pDef.projKind, player.x, player.z, pDef.dirX, pDef.dirZ);
        proj.speed = pDef.speed;
        proj.damage = pDef.damage;
        proj.ttl = pDef.ttlMs;
        proj.ownerIsPlayer = true;
        this.state.projectiles.push(proj);
        if (pDef.effects && pDef.effects.burn) {
          this._burnByProjId = this._burnByProjId || new Map();
          this._burnByProjId.set(proj.id, pDef.effects.burn);
        }
      }
    }
    for (const osid of pvpVictims) {
      const victim = state.players.get(osid);
      if (victim) this.damagePlayer(osid, victim, skillPvpDmg, player.x, player.z);
    }
    this.logEvent('skill_cast', { sid, character: player.character, skill: def.key });
  }

  spawnProjectile(sid, player, atkDef) {
    const { fx, fz } = { fx: Math.sin(player.rotY), fz: Math.cos(player.rotY) };
    const proj = new ProjectileState(this._projectileId++, sid, atkDef.projKind, player.x, player.z, fx, fz);
    proj.speed = atkDef.speed;
    const effDmg = (atkDef.kind === 'projectile') ? effectiveRangedDamage(player.character, player.upgrades) : atkDef.damage;
    proj.damage = effDmg;
    proj.ttl = atkDef.ttlMs;
    proj.ownerIsPlayer = true;
    this.state.projectiles.push(proj);
  }

  updateProjectiles(dt) {
    const state = this.state;
    const hitRadius = SERVER.projectile.hitRadius;
    for (let i = state.projectiles.length - 1; i >= 0; i--) {
      const proj = state.projectiles[i];
      stepProjectile(proj, dt);
      if (projectileExpired(proj, this.half)) {
        state.projectiles.splice(i, 1);
        continue;
      }
      let removed = false;
      if (proj.ownerIsPlayer) {
        for (const enemy of state.enemies) {
          if (enemy.hp <= 0) continue;
          if (projectileHitsTarget(proj, enemy, hitRadius)) {
            this.hitEnemy(enemy, proj.damage, proj.x, proj.z, state.players.get(proj.ownerSid));
            if (this._burnByProjId && this._burnByProjId.has(proj.id)) {
              const burn = this._burnByProjId.get(proj.id);
              this._burnByProjId.delete(proj.id);
              this._activeBurns = this._activeBurns || new Map();
              this._activeBurns.set(enemy, { damage: burn.damage, remainingMs: burn.durationMs, tickMs: burn.tickMs, lastTickMs: Date.now() });
            }
            state.projectiles.splice(i, 1);
            removed = true;
            break;
          }
        }
      }
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

  onRespawn(client) {
    const player = this.state.players.get(client.sessionId);
    if (!player || player.hp > 0) return;
    const p = this.randomPosInActiveChunks();
    player.x = p.x;
    player.z = p.z;
    player.hp = effectiveMaxHp(player.character, player.upgrades);
    player.anim = 'idle';
    player.blocking = false;
    player.attackCd = 0;
    player.skillCd = 0;
    player.effects.clear();
    this.inputs.set(client.sessionId, { dirX: 0, dirZ: 0 });
    this.attackAt.set(client.sessionId, 0);
    this.skillAt.set(client.sessionId, 0);
    this.animUntil.set(client.sessionId, 0);
    this.invulnUntil.set(client.sessionId, Date.now() + 1000);
    this.logEvent('player_respawn', { sid: client.sessionId });
  }

  onInput(client, msg = {}) {
    const sid = client.sessionId;
    const now = Date.now();
    const times = this.msgTimes.get(sid) || [];
    times.push(now);
    while (times.length && times[0] < now - 1000) times.shift();
    if (times.length > SERVER.net.maxInputPerSecond) {
      this.warnEvent('input_dropped_rate', { sid, perSecond: SERVER.net.maxInputPerSecond });
      return;
    }
    WorldRoom.stats.inputTimes.push(now);
    const player = this.state.players.get(sid);
    if (!player || player.hp <= 0) {
      this.warnEvent('input_rejected_dead', { sid });
      return;
    }
    let dirX = Number(msg.dirX);
    let dirZ = Number(msg.dirZ);
    if (!Number.isFinite(dirX) || !Number.isFinite(dirZ)) { dirX = 0; dirZ = 0; }
    const len = Math.hypot(dirX, dirZ);
    if (len > 1) { dirX /= len; dirZ /= len; }
    const blocking = !!msg.block;
    player.blocking = blocking;
    this.inputs.set(sid, { dirX, dirZ });
    if (msg.attack) {
      const reject = (reason, extra = {}) => this.warnEvent('input_attack_rejected', { sid, reason, ...extra });
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
        player.anim = 'attack';
        const atk = attackFor(player.character);
        if (atk.kind === 'projectile') {
          this.spawnProjectile(sid, player, atk);
        } else {
          this.pendingMelee.push({ sid, at: now + SERVER.player.attackImpactMs });
        }
      }
    }
    if (msg.skill) {
      const reject = (reason) => this.warnEvent('input_skill_rejected', { sid, reason });
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

  update(dt) {
    const state = this.state;
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
    this.checkAutoPicks();
    // Update chunk streaming for each player every tick (cheap)
    for (const sid of this.state.players.keys()) {
      this.updatePlayerChunks(sid);
    }
    this.updatePlaying(dt);
  }

  movePlayers(dt) {
    const now = Date.now();
    for (const [sid, player] of this.state.players) {
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
      const stepped = stepPlayer(player.x, player.z, player.rotY, dirX, dirZ, speed, dt, this.half);
      player.x = stepped.x;
      player.z = stepped.z;
      player.rotY = stepped.rotY;
      if (now >= this.animUntil.get(sid)) {
        player.anim = (dirX || dirZ) ? 'run' : 'idle';
      }
      player.attackCd = Math.max(0, this.attackAt.get(sid) - now);
      player.skillCd = Math.max(0, this.skillAt.get(sid) - now);
    }
  }

  setEnemiesIdle() {
    for (const enemy of this.state.enemies) enemy.anim = 'idle';
  }

  updatePlaying(dt) {
    const now = Date.now();
    const state = this.state;
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
    // Enemies — chase nearest living player, no wave intermission in open world
    for (const enemy of state.enemies) {
      if (enemy.hp <= 0) continue;
      const animOverride = now < (this.enemyAnimUntil.get(enemy) || 0);
      if (!animOverride) this.enemyAnimUntil.delete(enemy);
      if (now < (this.enemyStunUntil.get(enemy) || 0)) {
        enemy.anim = 'hit';
        continue;
      }
      this.enemyStunUntil.delete(enemy);
      let targetSid = null;
      let target = null;
      let best = Infinity;
      for (const [sid, player] of state.players) {
        if (player.hp <= 0) continue;
        const dx = enemy.x - player.x;
        const dz = enemy.z - player.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; target = player; targetSid = sid; }
      }
      if (target) {
        const dist = Math.sqrt(best);
        enemy.rotY = Math.atan2(target.x - enemy.x, target.z - enemy.z);
        if (dist > SERVER.enemy.contactRange) {
          enemy.x += (target.x - enemy.x) / dist * SERVER.enemy.speed * dt;
          enemy.z += (target.z - enemy.z) / dist * SERVER.enemy.speed * dt;
          if (!animOverride) enemy.anim = 'run';
        } else if (now >= this.invulnUntil.get(targetSid)) {
          this.enemyAnimUntil.set(enemy, now + SERVER.enemy.attackAnimMs);
          enemy.anim = 'attack';
          this.damagePlayer(targetSid, target, SERVER.enemy.contactDamage, enemy.x, enemy.z);
        } else if (!animOverride) {
          enemy.anim = 'idle';
        }
      } else if (!animOverride) {
        enemy.anim = 'idle';
      }
    }
    // Respawn enemies if too few active (open world keeps pressure)
    const alive = [...state.enemies].filter((e) => e.hp > 0).length;
    const desired = enemiesForLevel(this.avgPlayerLevel());
    if (alive < desired) {
      // Find a dead slot and revive it in an active chunk
      const dead = state.enemies.find((e) => e.hp <= 0);
      if (dead) {
        const pos = this.randomPosInActiveChunks();
        dead.x = pos.x;
        dead.z = pos.z;
        dead.hp = 2 + Math.floor((this.avgPlayerLevel() - 1) / 2);
        dead.anim = 'idle';
      }
    }
  }

  updatePickups(dt) {
    const state = this.state;
    const orbScore = (player) => SERVER.orb.score * (player.effects.has('double') ? SERVER.powerUps.double.multiplier : 1);
    for (const orb of state.orbs) {
      for (const [sid, player] of state.players) {
        if (player.hp <= 0) continue;
        const radius = SERVER.orb.radius * effectivePickupMult(player.upgrades);
        const dx = orb.x - player.x;
        const dz = orb.z - player.z;
        if (dx * dx + dz * dz < radius * radius) {
          player.score += orbScore(player);
          this.grantXp(sid, SERVER.progression?.xpPerOrb ?? 20);
          const p = this.randomPosInActiveChunks();
          orb.x = p.x;
          orb.z = p.z;
          break;
        }
      }
    }
    for (const pu of state.powerUps) {
      if (!pu.active) {
        const left = (this.powerUpTimers.get(pu) ?? 0) - dt;
        if (left > 0) {
          this.powerUpTimers.set(pu, left);
          continue;
        }
        this.powerUpTimers.delete(pu);
        const p = this.randomPosInActiveChunks();
        pu.x = p.x;
        pu.z = p.z;
        pu.active = true;
        continue;
      }
      const cfg = SERVER.powerUps[pu.type];
      for (const player of state.players.values()) {
        if (player.hp <= 0) continue;
        const radius = SERVER.powerUps.radius * effectivePickupMult(player.upgrades);
        const dx = pu.x - player.x;
        const dz = pu.z - player.z;
        if (dx * dx + dz * dz < radius * radius) {
          player.effects.set(pu.type, cfg.durationMs);
          pu.active = false;
          this.powerUpTimers.set(pu, SERVER.powerUps.respawnSeconds);
          this.logEvent('player_pickup', { name: player.name, type: pu.type });
          break;
        }
      }
    }
  }

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
