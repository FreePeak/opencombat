// Client-side configuration. The server (src/server/config.js) owns the
// simulation; this file only mirrors the numbers the client needs for
// rendering, the camera rig and the HUD. Keep the two in sync by hand.
export const CONFIG = {
  serverUrl: 'ws://localhost:2567',

  world: { size: 60 },          // square arena, matches SERVER.world.size

  // Renderer quality knobs (Upgrade F): dpr clamp avoids fill-rate blowups
  // on retina screens; the shadow map size trades quality for memory.
  renderer: {
    dprMax: 2,
    shadowMapSize: 2048,
    shadows: true
  },

  match: {
    countdownSeconds: 3,        // mirror of SERVER.match.countdownSeconds
    targetScore: 100            // mirror, shown in the HUD
  },

  player: {
    speed: 9,                   // mirror of SERVER.player.speed (server wins)
    maxHp: 100,
    attackCooldownMs: 800,      // mirror of the server cooldown (HUD bar)
    attackAnimMs: 350,          // mirror of SERVER.player.attackAnimMs
    camera: { height: 7, distance: 10, lerp: 0.08 }, // third-person rig
    shake: { duration: 0.3, amplitude: 0.3 }         // damage camera shake
  },

  orb: { score: 10, y: 0.9 },   // y = float height above the ground

  powerUps: {
    y: 1.0,                     // float height above the ground
    colors: {
      speed: 0x00e5ff,          // cyan
      shield: 0x4dabff,         // blue
      double: 0xffd700          // gold
    },
    respawnSeconds: 15          // mirror of SERVER.powerUps.respawnSeconds
  },

  effects: {                    // visuals per active effect
    speed:  { color: 0x00e5ff, durationMs: 5000 },
    shield: { color: 0x4dabff, durationMs: 15000, sphereOpacity: 0.18 },
    double: { color: 0xffd700, durationMs: 10000 }
  },

  colors: {
    orb: 0x66ff66,
    ground: 0x3f7d46,
    nametagBg: 'rgba(0,0,0,0.55)'
  },

  // Clip names inside the Quaternius GLBs (see assets/credits/). Our
  // logical anim names map onto them; the server sends these logical names
  // in PlayerState.anim / EnemyState.anim.
  anims: {
    player: {
      idle: 'CharacterArmature|Idle',
      run: 'CharacterArmature|Run',
      attack: 'CharacterArmature|Sword_Slash'
    },
    enemy: {
      idle: 'CharacterArmature|Idle',
      run: 'CharacterArmature|Run',
      attack: 'CharacterArmature|Punch',
      hit: 'CharacterArmature|HitReact'
    }
  }
};
