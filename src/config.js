// Client-side configuration. The server (src/server/config.js) owns the
// simulation; this file only mirrors the numbers the client needs for
// rendering, the camera rig and the HUD. Keep the two in sync by hand.
//
// Server URL fallback chain (never hardcode ws://localhost:2567):
//   1. window.__OPENGAME__.wsUrl  — injected by the server via /env.js
//      (PUBLIC_URL env var), so deployed clients talk to their own origin;
//   2. same-origin host           — reverse-proxy deploys (ws(s)://this page);
//   3. ws://localhost:2567        — local dev default.
const env = (typeof window !== 'undefined' && window.__OPENGAME__) || {};
const locationHost = typeof window !== 'undefined' && window.location ? window.location.host : '';
const wsScheme = typeof window !== 'undefined' && window.location?.protocol === 'https:' ? 'wss' : 'ws';
const serverUrl = env.wsUrl || (locationHost ? `${wsScheme}://${locationHost}` : 'ws://localhost:2567');

export const CONFIG = {
  serverUrl,

  world: { size: 60 },          // square arena, matches SERVER.world.size

  // Renderer quality knobs: dpr clamp avoids fill-rate blowups on retina
  // screens; shadows can be disabled for low-end clients (DISABLE_SHADOWS
  // env -> /env.js -> window.__OPENGAME__.shadows).
  renderer: {
    dprMax: 2,
    shadowMapSize: 2048,
    shadows: env.shadows !== false
  },

  // Loading guard: the join click fails with a clear message if the GLB
  // models (or their CDN) take longer than this.
  loadTimeoutMs: 15000,

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

  // Selectable player characters. `key` indexes the loaded GLB map in
  // GameScene.loadModels(); `scale` normalizes every model to the same
  // in-game height (~1.55 units, the adventurer's height at 0.85); `anims`
  // maps our logical names onto clip names inside the GLB (null = the model
  // ships no clips and the client plays a procedural fallback); `weapon`
  // picks what is attached to the right hand ('sword' GLB, 'bow' procedural,
  // or null when the model carries its own weapon). The server clamps the
  // index to [0, characters.length) — keep both sides in sync.
  characters: [
    {
      key: 'swordsman', label: 'Knight', file: 'knight_mixamo.glb', scale: 0.97, weapon: null,
      anims: {
        idle: 'CharacterArmature|Idle',
        run: 'CharacterArmature|Run',
        attack: 'CharacterArmature|Attack'
      }
    },
    {
      key: 'archer', label: 'Archer', file: 'archer.glb', scale: 0.85, weapon: 'bow',
      anims: {
        idle: 'CharacterArmature|Idle',
        run: 'CharacterArmature|Run',
        attack: 'CharacterArmature|Sword_Slash'
      }
    },
    {
      key: 'mage', label: 'Mage', file: 'mage.glb', scale: 0.6, weapon: null,
      anims: {
        idle: 'CharacterArmature|Idle',
        run: 'CharacterArmature|Run',
        attack: 'CharacterArmature|Staff_Attack'
      }
    },
    {
      key: 'spike', label: 'Spike Man', file: 'spike.glb', scale: 0.65, weapon: null,
      anims: {
        idle: 'CharacterArmature|Idle',
        run: 'CharacterArmature|Run',
        attack: 'CharacterArmature|Punch'
      }
    }
  ],

  // Clip names inside the enemy GLB (see assets/credits/). The server sends
  // logical anim names in EnemyState.anim.
  anims: {
    enemy: {
      idle: 'CharacterArmature|Idle',
      run: 'CharacterArmature|Run',
      attack: 'CharacterArmature|Punch',
      hit: 'CharacterArmature|HitReact'
    }
  }
};
