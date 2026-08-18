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
  redis: { url: env.REDIS_URL || '' },  // '' = LocalPresence (single process)
  // Dev-only live reload (see liveReload.js): off in production / LIVE_RELOAD=0.
  liveReload: env.NODE_ENV !== 'production' && env.LIVE_RELOAD !== '0',

  // Fixed-timestep loop: the room updates every tickMs. dt is computed from
  // REAL elapsed time (clock drift compensation), clamped to avoid a giant
  // step after a process stall.
  tickMs: Number(env.TICK_MS || 50),

  // Square arena centered on the origin: [-half, half] on both X and Z.
  world: { size: 60 },

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
    skillPvpDamage: 15,       // skill (K) damage vs other players
    rangedDamage: 1,          // base ranged normal damage vs enemies
    rangedPvpDamage: 8,       // ranged normal damage vs other players
    // L block: while held the player is rooted and every hit whose source
    // lies inside the FRONTAL hemisphere (dot >= 0) deals no damage.
    blockArcCos: 0,
    blockKnockback: 1.1       // nudge applied to a blocked victim (cosmetic)
  },

  orb: {
    count: 10,
    score: 10,                // points per orb (doubled by the DOUBLE power-up)
    radius: 0.9
  },

  // WAVES: enemies spawn in waves out of a fixed pool. Clearing every enemy
  // freezes combat in 'intermission' (players invulnerable, free movement)
  // until someone clicks the wave-cleared popup -> next wave spawns (more
  // enemies, slightly tankier) after the standard countdown. Killed enemies
  // STAY DEAD for the rest of the wave — the old instant-respawn elsewhere
  // is gone.
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
    count: 3,                 // one of each type
    respawnSeconds: 15,
    radius: 0.9,
    speed:  { durationMs: 5000,  multiplier: 2 },  // 2x move speed
    shield: { durationMs: 15000 },                 // blocks ONE enemy hit
    double: { durationMs: 10000, multiplier: 2 }   // 2x orb score
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

  // Playable character roster size — mirrors the length of CONFIG.characters
  // in the client config (src/config.js). Join options are clamped to this.
  characters: { count: 4 },

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
