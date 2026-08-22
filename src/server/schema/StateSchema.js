// Colyseus schemas: the authoritative state broadcast to every client on
// every patch (default ~20Hz). The client renders from these values and
// never mutates them.
//
// WHY defineTypes() and not @type() decorators: Node (this project runs
// plain .js with no build step) does not support stage-3 decorators yet,
// and @colyseus/schema's decorators are TS-legacy style anyway. defineTypes
// is the library's documented non-decorator equivalent — same schema, same
// wire format.
import { Schema, MapSchema, ArraySchema, defineTypes } from '@colyseus/schema';

// One connected player. x/z are world X/Z (y unused for now — flat arena).
export class PlayerState extends Schema {
  constructor(x = 0, z = 0) {
    super();
    this.x = x;
    this.y = 0;
    this.z = z;
    this.rotY = 0;    // facing angle, radians (atan2 convention: +Z is 0)
    this.hp = 100;
    this.score = 0;
    this.tier = 0;    // cosmetic unlock tier (career.bestWave thresholds)
    this.anim = 'idle';       // 'idle' | 'run' | 'attack' — drives AnimationMixer
    this.name = '';           // chosen pre-join, rides the join options
    this.character = 0;       // chosen pre-join: index into CONFIG.characters
    this.color = 0xffffff;    // server-assigned from SERVER.colors palette
    this.effects = new MapSchema(); // power-up name -> remaining ms
    this.attackCd = 0;        // ms until J works again (HUD bar + anti-cheat)
    this.skillCd = 0;         // ms until K (the per-character skill) works again
    this.blocking = false;    // L held: guarding — negates frontal hits
    // Phase 4: leveling + upgrade cards
    this.level = 1;
    this.xp = 0;
    this.pendingChoices = new ArraySchema(); // 3 ids while a level-up is pending (empty otherwise)
    this.upgrades = new MapSchema();        // upgrade id -> stack count
    // Phase 5: arena team assignment (−1 = unassigned, 0/1 for duel/team, index for FFA)
    this.team = -1;
  }
}
defineTypes(PlayerState, {
  x: 'number', y: 'number', z: 'number',
  rotY: 'number',
  hp: 'number',
  score: 'number',
  anim: 'string',
  name: 'string',
  character: 'number',
  color: 'number',
  effects: { map: 'number' },
  attackCd: 'number',
  skillCd: 'number',
  blocking: 'boolean',
  level: 'number',
  xp: 'number',
  pendingChoices: ['string'],
  upgrades: { map: 'number' },
  team: 'number',
  tier: 'number'
});

// One collectible. Shared pool: first player within radius wins, the orb
// then teleports (respawns) to a new random spot — all server-side.
export class OrbState extends Schema {
  constructor(x = 0, z = 0) {
    super();
    this.x = x;
    this.z = z;
    this.charge = 0; // stored kill-XP (PRD-orb-drops.md) — >0 renders gold
  }
}
defineTypes(OrbState, { x: 'number', z: 'number', charge: 'number' });

// One power-up pick-up. type cycles through speed/shield/double; active=false
// while it is respawning (clients hide it).
export class PowerUpState extends Schema {
  constructor(x = 0, z = 0, type = '') {
    super();
    this.x = x;
    this.z = z;
    this.type = type;
    this.active = true;
  }
}
defineTypes(PowerUpState, { x: 'number', z: 'number', type: 'string', active: 'boolean' });

// One server-side enemy. The client renders it and plays its anim clips,
// but all logic (chase, damage, death, respawn) happens in GameRoom.
export class EnemyState extends Schema {
  constructor(x = 0, z = 0) {
    super();
    this.x = x;
    this.z = z;
    this.rotY = 0;
    this.hp = 2;
    this.anim = 'idle'; // 'idle' | 'run' | 'attack' | 'hit'
    this.elite = '';    // '' | affix name from shared/sim/elites.js
    this.archetype = ''; // '' | archetype tag from shared/sim/archetypes.js
  }
}
defineTypes(EnemyState, {
  x: 'number', z: 'number',
  rotY: 'number',
  hp: 'number',
  anim: 'string',
  elite: 'string',
  archetype: 'string'
});

// One in-flight projectile (arrow / fireball / lightning bolt). The server
// spawns it on attack input, steps it each tick, and removes it on hit or
// TTL expiry. The client renders it and plays impact VFX.
export class ProjectileState extends Schema {
  constructor(id = 0, ownerSid = '', kind = '', x = 0, z = 0, dirX = 0, dirZ = 0) {
    super();
    this.id = id;
    this.ownerSid = ownerSid;
    this.kind = kind;         // 'arrow' | 'fireball' | 'lightning'
    this.x = x;
    this.z = z;
    this.dirX = dirX;
    this.dirZ = dirZ;
    this.speed = 0;
    this.damage = 0;
    this.ttl = 0;             // remaining ms
    this.ownerIsPlayer = true;
  }
}
defineTypes(ProjectileState, {
  id: 'number',
  ownerSid: 'string',
  kind: 'string',
  x: 'number', z: 'number',
  dirX: 'number', dirZ: 'number',
  speed: 'number',
  damage: 'number',
  ttl: 'number',
  ownerIsPlayer: 'boolean'
});

// Top-level room state. players is keyed by sessionId so join/leave maps
// 1:1 onto the MapSchema add/remove patches.
export class WorldState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.orbs = new ArraySchema();
    this.enemies = new ArraySchema();
    this.powerUps = new ArraySchema();
    this.projectiles = new ArraySchema();
    this.matchState = 'lobby';  // 'lobby' | 'countdown' | 'playing' | 'intermission' | 'gameover'
    this.countdown = 0;         // seconds left in the countdown (0 otherwise)
    this.wave = 1;              // current enemy wave (1-based)
    this.victory = false;       // co-op win: finale cleared (PRD-wave-finale.md)
    this.winnerId = '';         // sessionId of the match winner
    this.winnerName = '';       // ...and their name, for the results overlay
    this.paused = false;        // true while choosing upgrade/shop (PVE pause)
    this.intermissionUntil = 0; // ms epoch when intermission auto-advances
    // Phase 5: arena metadata (defaults keep GameRoom rooms backward compatible)
    this.arenaMode = '';        // '' = survival (game room), else 'duel'|'team'|'ffa'
    this.arenaPve = false;      // optional PvE toggle for arena
    this.arenaRoundsToWin = 0;  // 0 = not arena, else 1..5
    this.arenaRound = 0;        // current round number (1-based in arena)
    this.arenaTargetScore = 0;  // per-round score needed to win a round
    this.arenaRoundWins = new MapSchema(); // key: sid or teamId string -> rounds won
  }
}
defineTypes(WorldState, {
  players: { map: PlayerState },
  orbs: [OrbState],
  enemies: [EnemyState],
  powerUps: [PowerUpState],
  projectiles: [ProjectileState],
  matchState: 'string',
  countdown: 'number',
  wave: 'number',
  victory: 'boolean',
  winnerId: 'string',
  winnerName: 'string',
  paused: 'boolean',
  intermissionUntil: 'number',
  arenaMode: 'string',
  arenaPve: 'boolean',
  arenaRoundsToWin: 'number',
  arenaRound: 'number',
  arenaTargetScore: 'number',
  arenaRoundWins: { map: 'number' }
});

// Lobby staging state: the queue before the arena.
export class LobbyState extends Schema {
  constructor() {
    super();
    this.queued = new MapSchema(); // sid -> mode string (debug) or placeholder
    this.queueCount = 0;
  }
}
defineTypes(LobbyState, {
  queued: { map: 'string' },
  queueCount: 'number'
});
