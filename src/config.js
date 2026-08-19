// Client-side configuration. The server (src/server/config.js) owns the
// simulation; this file only mirrors the numbers the client needs for
// rendering, the camera rig and the HUD. Keep the two in sync by hand.
//
// Server URL fallback chain (never hardcode ws://localhost:2567):
//   1. ?server= query param       — share links, e.g. a GitHub Pages page
//                                   pointing at someone's tunnel host;
//   2. localStorage opengame.server — sticky copy of the last ?server= param,
//                                   so the choice survives losing the param;
//   3. window.__OPENGAME__.wsUrl  — injected by the server via /env.js
//                                   (PUBLIC_URL env var), or the committed
//                                   static env.js on GitHub Pages hosting;
//   4. same-origin host           — reverse-proxy deploys (ws(s)://this page);
//   5. ws://localhost:2567        — local dev default.
const env = (typeof window !== 'undefined' && window.__OPENGAME__) || {};
const loc = typeof window !== 'undefined' && window.location ? window.location : null;
const securePage = loc?.protocol === 'https:';

// localStorage can throw in sandboxed iframes / privacy modes — config runs
// at module load, so a throw here would kill the whole boot.
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} }
};

/** Accepts a bare host, http(s)://… or ws(s)://… and returns a ws(s):// URL.
 *  The scheme follows the PAGE protocol: an https page must never open an
 *  insecure ws:// socket (browsers block the mixed content), so http(s)
 *  input is upgraded to wss when the page itself is https. */
function normalizeServerUrl(input) {
  let s = String(input || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = (securePage ? 'https' : 'http') + '://' + s;
  s = s.replace(/^http/i, 'ws'); // http -> ws, https -> wss
  if (securePage && s.startsWith('ws://')) s = 'wss' + s.slice(2);
  try { new URL(s); } catch { return null; } // garbage input -> keep default
  return s;
}

const paramServer = loc ? new URLSearchParams(loc.search).get('server') : null;
if (paramServer) storage.set('opengame.server', paramServer);
const serverUrl = normalizeServerUrl(paramServer)
  || normalizeServerUrl(storage.get('opengame.server'))
  || env.wsUrl
  || (loc?.host ? `${securePage ? 'wss' : 'ws'}://${loc.host}` : 'ws://localhost:2567');

/** Retarget the client at a server typed on the login screen (e.g. a fresh
 *  *.trycloudflare.com URL). Normalizes like ?server= input, updates
 *  CONFIG.serverUrl (network.js rebuilds its client) and persists the raw
 *  value so the field prefills next visit. Empty/invalid input keeps the
 *  current target; returns the normalized URL or null. */
export function setServerUrl(raw) {
  const url = normalizeServerUrl(raw);
  if (url) {
    CONFIG.serverUrl = url;
    storage.set('opengame.server', String(raw).trim());
  }
  return url;
}

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
    attackAnimMs: 450,          // mirror of SERVER.player.attackAnimMs — the
                                // full visible swing window (clip squeezed in)
    camera: { height: 7, distance: 10, lerp: 0.08, yaw: Math.PI }, // third-person rig; yaw = fixed azimuth (RC5)
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
    double: { color: 0xffd700, durationMs: 10000 },
    // BLOCK (hold L) is a player action, not a power-up — this is the guard
    // wall tint (mirror of SERVER.player.block* rules).
    block:  { color: 0x7ec8ff, opacity: 0.35 }
  },

  colors: {
    orb: 0x66ff66,
    ground: 0x3f7d46,
    nametagBg: 'rgba(0,0,0,0.55)'
  },

  // Projectile visuals per kind (Phase 1 ranged normals).
  projectiles: {
    arrow:    { color: 0xd4a574, emissive: 0x8b6914, scale: 0.12, height: 0.6 },
    fireball: { color: 0xff4500, emissive: 0xff2200, scale: 0.25, lightColor: 0xff6600, lightIntensity: 2 },
    lightning: { color: 0x7b68ee, emissive: 0x5b4cdd, scale: 0.1, height: 0.8 }
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
      // The knight Attack clip (1.43s) is a static raised-sword pose for
      // the first 1.07s (frames 1–64); the real slash is only frames 65–85.
      // Trim to the slash so each attack is one visible swing, not a loop
      // of drawing the sword (frames are 0-indexed, fps=60, endFrame is
      // exclusive — stops before the snap-back key at frame 86).
      attackSubclip: { startFrame: 65, endFrame: 86, fps: 60 },
      // The knight Idle clip (1.5s) EMBEDS a sword-draw gesture: from
      // t≈0.3–1.15s the arm sweeps through a big raise, then settles.
      // Looping the full clip replayed the "draw" every 1.5s whenever the
      // knight stood still (after an attack or after stopping). Frames
      // 77–90 are the settled calm stance (all bone deltas ≤ ~0.09) — loop
      // only that. startFrame is 76, one earlier than intended: GLB key
      // times are fp32-quantized, so the frame-77 key lands at 76.9998 and
      // the subclip's `frame < startFrame` filter drops it unless the
      // window starts at 76. endFrame 91 is exclusive (keeps frame 90).
      idleSubclip: { startFrame: 76, endFrame: 91, fps: 60 },
      anims: {
        idle: 'CharacterArmature|Idle',
        run: 'CharacterArmature|Run',
        attack: 'CharacterArmature|Attack'
      }
    },
    {
      key: 'archer', label: 'Archer', file: 'archer.glb', scale: 0.85, weapon: 'bow',
      anims: {
        idle: 'CharacterArmature|Idle_Gun',
        run: 'CharacterArmature|Run',
        // Gun_Shoot is the closest to a bow shot (0.75s quick release).
        // Skill uses Sword_Slash (1.29s sweeping motion → reads as multishot
        // fan). They MUST be different clips — when attack === skill the
        // animation weight is immediately zeroed by the blended-action guard
        // in updateClipAnims.
        attack: 'CharacterArmature|Gun_Shoot',
        skill: 'CharacterArmature|Sword_Slash'
      }
    },
    {
      key: 'mage', label: 'Mage', file: 'mage.glb', scale: 0.6, weapon: null,
      anims: {
        idle: 'CharacterArmature|Idle',
        run: 'CharacterArmature|Run',
        attack: 'CharacterArmature|Staff_Attack',
        // Phase 3: firewave uses Spell clip
        skill: 'CharacterArmature|Spell'
      }
    },
    {
      // Demon (was "Spike Man"): the GLB file keeps its original spike.glb
      // name — the rename is display-only (key + label).
      key: 'demon', label: 'Demon', file: 'spike.glb', scale: 0.65, weapon: null,
      anims: {
        idle: 'CharacterArmature|Idle',
        run: 'CharacterArmature|Run',
        attack: 'CharacterArmature|Punch',
        // Phase 3: chain lightning uses Weapon clip
        skill: 'CharacterArmature|Weapon'
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
