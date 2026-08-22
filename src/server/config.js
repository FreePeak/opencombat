// Server-side tunables — authoritative gameplay numbers and deployment
// configuration. Anything that affects the simulation lives here because the
// server is authoritative. Environment overrides (see README "Environment"):
//   PORT, PUBLIC_URL, DISABLE_SHADOWS, REDIS_URL, TICK_MS,
//   RATE_LIMIT_CAPACITY.
// This module is ALSO evaluated in the browser: src/LocalRoom.js (the
// offline single-player sim on GitHub Pages) imports the same tunables.
// Browsers have no `process` — fall back to pure defaults there.
const env = (typeof process !== 'undefined' && process.env) || {};

const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
// ws(s):// twin of PUBLIC_URL, injected into /env.js for the browser client.
const publicWsUrl = publicUrl ? publicUrl.replace(/^http/, 'ws') : null;

export const SERVER = {
  port: Number(env.PORT || 2567),
  publicUrl,            // e.g. https://game.example.com ('' = same-origin)
  publicWsUrl,          // ws(s)://... (null = client falls back to its own host)
  disableShadows: ['1', 'true'].includes((env.DISABLE_SHADOWS || '').toLowerCase()),
  // Bloom (ARTWORK_PLAN phase 6): off by default, enable with ENABLE_BLOOM=1/true.
  // Gated on the client via CONFIG.renderer.bloom (default false until perf-verified).
  bloomEnabled: ['1', 'true'].includes((env.ENABLE_BLOOM || '').toLowerCase()),
  redis: { url: env.REDIS_URL || '' },  // '' = LocalPresence (single process)
  // Dev-only live reload (see liveReload.js): off in production / LIVE_RELOAD=0.
  liveReload: env.NODE_ENV !== 'production' && env.LIVE_RELOAD !== '0',

  // Fixed-timestep loop: the room updates every tickMs. dt is computed from
  // REAL elapsed time (clock drift compensation), clamped to avoid a giant
  // step after a process stall.
  tickMs: Number(env.TICK_MS || 50),

  // Square arena centered on the origin: [-half, half] on both X and Z.
  // Open world chunked generation (Phase 6) reuses the same world size for arena, but
  // chunked generation is unbounded (chunk size 32, radius 2, seeded).
  world: {
    size: 60,
    chunkSize: 32,
    chunkRadius: 2,
    seed: Number(env.WORLD_SEED || 1337),
    activeChunkRadius: 2,
  },

  // Persistence: per-player JSON files `data/players/<name>.json`, debounced 2s (Phase 6).
  // PERSISTENCE_DRIVER=postgres swaps the backing store (PRD-postgres-adapter.md):
  // rows live in a `players` table, preloaded into memory at boot so the rooms'
  // synchronous read path is unchanged; writes stay debounced and flush to SQL.
  persistence: {
    dir: 'data/players',
    debounceMs: 2000,
    driver: env.PERSISTENCE_DRIVER || 'json',
    databaseUrl: env.DATABASE_URL || '',
  },

  // Match lifecycle: LOBBY -> COUNTDOWN -> PLAYING -> GAME_OVER.
  // Design choice (documented in README): with minPlayers = 1 the countdown
  // starts as soon as the first player joins — no waiting for friends.
  match: {
    minPlayers: 1,
    countdownSeconds: 3,      // 3-2-1-GO, broadcast in WorldState.countdown
    targetScore: 100,         // first player to reach this wins (0 = disabled)
    matchDurationSeconds: 0,  // timed mode: highest score wins (0 = disabled)
    reconnectGraceMs: 15000,  // keep a dropped player's seat + state this long
    maxClients: 12,           // hard cap: one room cannot be overloaded
    emptyRoomTtlMs: 60000     // dispose rooms with 0 players after this long
  },

  player: {
    speed: 9,                 // units/second
    maxHp: 100,
    radius: 0.8,              // pick-up / contact distance
    invulnMs: 1000,           // invulnerability window after taking damage
    knockback: 7,             // units/second pushed away on damage
    attackRange: 2.6,         // melee reach
    attackArcCos: 0.5,        // cos(60°): hit enemies within a 60° cone
    attackCooldownMs: 800,    // J can't swing faster than this (HUD bar)
    attackAnimMs: 450,        // how long anim='attack' shows (full visible arc)
    attackImpactMs: 180,      // damage lands THIS far into the swing — aligned
                              // with the visual impact frame (~40% of the arc),
                              // not at button-press (production combat feel)
    attackDamage: 1,          // melee damage per hit vs enemies (enemy.hp hits kill)
    attackPvpDamage: 10,      // melee damage vs other players
    // skillPvpDamage removed in Phase 3 — per-class values live in CLASS_STATS
    rangedDamage: 1,          // base ranged normal damage vs enemies
    rangedPvpDamage: 8,       // ranged normal damage vs other players
    // L block: while held the player strafes at reduced speed and every hit
    // whose source lies inside the FRONTAL hemisphere (dot >= 0) deals no damage.
    blockArcCos: 0,
    blockKnockback: 1.1,      // nudge applied to a blocked victim (cosmetic)
    blockSpeedMult: 0.45      // movement speed multiplier while guarding
  },

  orb: {
    count: 10,
    score: 10,                // points per orb (doubled by the DOUBLE power-up)
    radius: 0.9
  },

  // PvE waves run forever: clearing every enemy enters 'intermission' (players
  // invulnerable, free movement + intermission shop) then AUTO-ADVANCES after
  // wave.intermissionMs (clicking 'nextWave' still skips the wait). Killed
  // enemies STAY DEAD until the next wave, which activates more/tankier ones
  // out of the fixed pool (see src/shared/waves.js).
  wave: {
    intermissionMs: 8000,         // wave-clear breather before next countdown
    maxPauseMs: 30000,            // global pause cap while upgrade/shop open
    finaleWave: 12,               // clearing this wave + advancing = co-op VICTORY (0 = endless)
  },

  enemy: {
    pool: 10,                 // fixed pool size (client hides the dead slots)
    waveBase: 3,              // wave 1 activates this many
    waveGrowth: 1,            // +1 active enemy per wave, capped at pool
    hp: 2,                    // wave-1 HP (two melee hits kill one)
    hpGrowth: 0.5,            // +1 max HP every 2 waves...
    hpMax: 5,                 // ...capped here
    killScore: 5,             // score for landing the killing blow
    speed: 4.5,               // chase speed, units/second
    contactRange: 1.3,        // how close before it damages the player
    contactDamage: 10,
    shotDamage: 8,            // Shooter archetype arrow damage (PRD-enemy-archetypes.md)
    aggroRange: 60,           // chase anything in the arena
    hitStunMs: 450,           // HIT-STUN: a struck enemy stops acting (no
                              // chase, no contact damage) until this expires
    hitAnimMs: 300,           // 'hit' react anim override after being struck
    hitKnockback: 0.5,        // units pushed away from the attacker on hit
    attackAnimMs: 400         // 'attack' punch anim after damaging a player
  },

  // Power-ups: timed effects applied server-side and broadcast as
  // PlayerState.effects (effect name -> remaining ms). After pickup the
  // power-up hides and respawns elsewhere after respawnSeconds.
  powerUps: {
    count: 4,                 // one of each type
    respawnSeconds: 15,
    radius: 0.9,
    speed:  { durationMs: 5000,  multiplier: 2 },  // 2x move speed
    shield: { durationMs: 15000 },                 // blocks ONE enemy hit
    double: { durationMs: 10000, multiplier: 2 },  // 2x orb score
    magnet: { durationMs: 8000, pullRadius: 8, pullSpeed: 10 } // orbs drift in (PRD-magnet.md)
  },

  // Projectile config: ranged normal attacks (Phase 1). Each class that fires
  // a projectile (archer/mage/demon) uses these numbers; the knight stays melee.
  projectile: {
    hitRadius: 0.8,            // collision sphere radius for projectile vs target
    arrowSpeed: 18,            // units/second
    arrowDamage: 1,
    arrowTtlMs: 1500,          // max lifetime (18 * 1.5 = 27 units range)
    fireballSpeed: 14,
    fireballDamage: 1,
    fireballTtlMs: 2000,       // 14 * 2 = 28 units range
    lightningSpeed: 22,
    lightningDamage: 1,
    lightningTtlMs: 1200,      // 22 * 1.2 = 26.4 units range
    rangedPvpDamage: 8         // PvP damage for all ranged normals
  },

  // Server-assigned player colors: same name always gets the same color
  // (stable across joins/reconnects).
  colors: [0xff8a65, 0xffd54f, 0xce93d8, 0xa5d6a7, 0xf48fb1, 0x90caf9, 0x4fc3f7],

  // Progression (Phase 4): leveling + upgrade cards.
  progression: {
    xpPerOrb: 20,               // XP per orb collected
    xpPerKill: 30,              // XP per enemy kill
    autoPickMs: 10000           // auto-pick first card after this long
  },

  // Playable character roster size — mirrors the length of CONFIG.characters
  // in the client config (src/config.js). Join options are clamped to this.
  characters: { count: 4 },

  // Arena PvP modes (Phase 5): duel / team / FFA, rounds, optional PvE toggle.
  arena: {
    modes: ['duel', 'team', 'ffa'],
    defaultMode: 'ffa',
    roundsToWin: 2,            // best-of-3 by default (first to 2 rounds wins)
    roundTargetScore: 30,        // score needed to win a single round (PvP kills + orbs)
    killScore: 10,               // PvP kill awards in arena (vs 5 for PvE)
    pveDefault: false,           // pure PvP unless the creator enables enemies
    duel: { minPlayers: 2, maxPlayers: 2 },
    team: { minPlayers: 2, maxPlayers: 12, teamSize: 2 },
    ffa:  { minPlayers: 2, maxPlayers: 12 }
  },

  // Lobby: queue -> redirect matchmaking for arena creation.
  lobby: {
    maxClients: 100,
    queueTickMs: 500,
    reservationMs: 10000
  },

  // --- Security boundaries ------------------------------------------------
  // These are abuse-hardening limits, not gameplay: hostile clients must not
  // be able to move faster than the server speed, spam input, or flood joins.
  net: {
    maxInputPerSecond: 30     // excess input messages are dropped + logged
  },
  // Per-IP token bucket on matchmaking HTTP calls (join/create/reconnect
  // requests): blunts join-flooding. In-memory per process — fine for one
  // instance; put a real rate limiter in front for multi-instance deploys.
  rateLimit: {
    capacity: Number(env.RATE_LIMIT_CAPACITY || 10), // burst of joins allowed
    refillPerSec: 0.5         // then one new token every 2s
  }
};
