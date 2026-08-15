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
    this.anim = 'idle';       // 'idle' | 'run' | 'attack' — drives AnimationMixer
    this.name = '';           // chosen pre-join, rides the join options
    this.character = 0;       // chosen pre-join: index into CONFIG.characters
    this.color = 0xffffff;    // server-assigned from SERVER.colors palette
    this.effects = new MapSchema(); // power-up name -> remaining ms
    this.attackCd = 0;        // ms until J works again (HUD bar + anti-cheat)
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
  attackCd: 'number'
});

// One collectible. Shared pool: first player within radius wins, the orb
// then teleports (respawns) to a new random spot — all server-side.
export class OrbState extends Schema {
  constructor(x = 0, z = 0) {
    super();
    this.x = x;
    this.z = z;
  }
}
defineTypes(OrbState, { x: 'number', z: 'number' });

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
  }
}
defineTypes(EnemyState, {
  x: 'number', z: 'number',
  rotY: 'number',
  hp: 'number',
  anim: 'string'
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
    this.matchState = 'lobby';  // 'lobby' | 'countdown' | 'playing' | 'gameover'
    this.countdown = 0;         // seconds left in the countdown (0 otherwise)
    this.winnerId = '';         // sessionId of the match winner
    this.winnerName = '';       // ...and their name, for the results overlay
  }
}
defineTypes(WorldState, {
  players: { map: PlayerState },
  orbs: [OrbState],
  enemies: [EnemyState],
  powerUps: [PowerUpState],
  matchState: 'string',
  countdown: 'number',
  winnerId: 'string',
  winnerName: 'string'
});
