// Server-side tunables — authoritative gameplay numbers and deployment
// configuration. Anything that affects the simulation lives here because the
// server is authoritative. Environment overrides (see README "Environment"):
//   PORT, PUBLIC_URL, DISABLE_SHADOWS, REDIS_URL, TICK_MS.
const env = process.env;

const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
// ws(s):// twin of PUBLIC_URL, injected into /env.js for the browser client.
const publicWsUrl = publicUrl ? publicUrl.replace(/^http/, 'ws') : null;

export const SERVER = {
  port: Number(env.PORT || 2567),
  publicUrl,            // e.g. https://game.example.com ('' = same-origin)
  publicWsUrl,          // ws(s)://... (null = client falls back to its own host)
  disableShadows: ['1', 'true'].includes((env.DISABLE_SHADOWS || '').toLowerCase()),
  redis: { url: env.REDIS_URL || '' },  // '' = LocalPresence (single process)

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
    attackAnimMs: 350         // how long anim='attack' shows
  },

  orb: {
    count: 10,
    score: 10,                // points per orb (doubled by the DOUBLE power-up)
    radius: 0.9
  },

  enemy: {
    count: 4,
    speed: 4.5,               // chase speed, units/second
    hp: 2,                    // two melee hits kill one
    contactRange: 1.3,        // how close before it damages the player
    contactDamage: 10,
    aggroRange: 60,           // chase anything in the arena
    hitAnimMs: 300,           // 'hit' flash after being struck
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

  // Server-assigned player colors: same name always gets the same color
  // (stable across joins/reconnects).
  colors: [0xff8a65, 0xffd54f, 0xce93d8, 0xa5d6a7, 0xf48fb1, 0x90caf9, 0x4fc3f7],

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
    capacity: 10,             // burst of joins allowed immediately
    refillPerSec: 0.5         // then one new token every 2s
  }
};
