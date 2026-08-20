// Deterministic chunked world generation — shared by server (WorldRoom) and client (chunk streaming).
// Chunk size 32, seeded, 3 biomes: Meadow / Dead Forest / Ashland. Pure functions, same inputs -> same chunk everywhere.

import { SERVER } from '../server/config.js';

export const CHUNK_SIZE = 32;
export const BIOMES = ['meadow', 'dead_forest', 'ashland'];
export const BIOME_MEADOW = 'meadow';
export const BIOME_DEAD_FOREST = 'dead_forest';
export const BIOME_ASHLAND = 'ashland';

// --- seeded RNG (LCG, same as progression.js / LocalRoom) ---
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function hash2D(cx, cz, seed) {
  // Mix chunk coords with global seed into a 32-bit hash
  const s = `${seed}:${cx},${cz}`;
  return hashString(s) || 1;
}

/** Chunk coords for world position (x,z). */
export function worldToChunk(x, z) {
  return {
    cx: Math.floor(x / CHUNK_SIZE),
    cz: Math.floor(z / CHUNK_SIZE),
  };
}

/** World-space origin (min corner) of chunk (cx,cz). */
export function chunkOrigin(cx, cz) {
  return { x: cx * CHUNK_SIZE, z: cz * CHUNK_SIZE };
}

/** String key for a chunk, e.g. "3,-2". */
export function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}

/** Parse chunk key back to coords. */
export function parseChunkKey(key) {
  const [cx, cz] = key.split(',').map(Number);
  return { cx, cz };
}

/** Deterministic biome for chunk (cx,cz) given global seed. */
export function biomeForChunk(cx, cz, seed = 0) {
  const h = hash2D(cx, cz, seed);
  // Use higher bits for biome selection to avoid correlation with prop RNG
  const idx = (h >>> 16) % BIOMES.length;
  return BIOMES[idx];
}

/** Biome color hint for minimap / ground tint. */
export function biomeColor(biome) {
  if (biome === BIOME_MEADOW) return 0x3f7d46;
  if (biome === BIOME_DEAD_FOREST) return 0x4a3b2a;
  if (biome === BIOME_ASHLAND) return 0x6b6b6b;
  return 0x3f7d46;
}

/**
 * Generate one chunk's contents deterministically.
 * @param {number} cx - chunk x
 * @param {number} cz - chunk z
 * @param {number|string} seed - global world seed (number or string)
 * @returns {{ cx:number, cz:number, x:number, z:number, biome:string, props:Array<{type:string,x:number,z:number,scale:number,rot:number}>, spawnPoints:Array<{x:number,z:number}>, grass:Array<{x:number,z:number,rot:number,scale:number}> }}
 */
export function generateChunk(cx, cz, seed = 0) {
  const biome = biomeForChunk(cx, cz, seed);
  const seedNum = typeof seed === 'string' ? hashString(seed) : (seed >>> 0);
  const chunkSeed = hash2D(cx, cz, seedNum);
  const rng = makeRng(chunkSeed);

  const origin = chunkOrigin(cx, cz);
  const props = [];
  const spawnPoints = [];

  // Biome-tuned densities (props per chunk)
  let treeCount, rockCount;
  if (biome === BIOME_MEADOW) {
    treeCount = 6 + Math.floor(rng() * 6); // 6-11
    rockCount = 2 + Math.floor(rng() * 3); // 2-4
  } else if (biome === BIOME_DEAD_FOREST) {
    treeCount = 8 + Math.floor(rng() * 8); // 8-15 denser dead forest
    rockCount = 1 + Math.floor(rng() * 2); // 1-2
  } else { // ashland
    treeCount = 1 + Math.floor(rng() * 2); // 1-2 sparse
    rockCount = 5 + Math.floor(rng() * 6); // 5-10 rocky
  }

  // Trees
  for (let i = 0; i < treeCount; i++) {
    const x = origin.x + rng() * CHUNK_SIZE;
    const z = origin.z + rng() * CHUNK_SIZE;
    const scale = 0.8 + rng() * 0.4; // 0.8-1.2
    const rot = rng() * Math.PI * 2;
    const type = biome === BIOME_DEAD_FOREST ? 'dead_tree' : 'tree';
    props.push({ type, x, z, scale, rot });
  }
  // Rocks
  for (let i = 0; i < rockCount; i++) {
    const x = origin.x + rng() * CHUNK_SIZE;
    const z = origin.z + rng() * CHUNK_SIZE;
    const scale = 0.7 + rng() * 0.6;
    const rot = rng() * Math.PI * 2;
    props.push({ type: 'rock', x, z, scale, rot });
  }

  // A few deterministic spawn points (for enemies/orbs) — not rendered, just for WorldRoom to pick from
  const spawnCount = 3 + Math.floor(rng() * 3); // 3-5
  for (let i = 0; i < spawnCount; i++) {
    const x = origin.x + 2 + rng() * (CHUNK_SIZE - 4);
    const z = origin.z + 2 + rng() * (CHUNK_SIZE - 4);
    spawnPoints.push({ x, z });
  }

  // Ground cover (ARTWORK_PLAN phase 1): per-tuft grass, biome-tuned density
  // (meadow lush, dead forest sparse, ashland near-bare). Drawn AFTER the
  // props + spawn-point sequences so those stay byte-identical to pre-grass
  // chunks — the server ignores this field, only the client renders it.
  let grassCount;
  if (biome === BIOME_MEADOW) grassCount = 26 + Math.floor(rng() * 12);
  else if (biome === BIOME_DEAD_FOREST) grassCount = 8 + Math.floor(rng() * 6);
  else grassCount = 2 + Math.floor(rng() * 3);
  const grass = [];
  for (let i = 0; i < grassCount; i++) {
    grass.push({
      x: origin.x + rng() * CHUNK_SIZE,
      z: origin.z + rng() * CHUNK_SIZE,
      rot: rng() * Math.PI * 2,
      scale: 0.7 + rng() * 0.6
    });
  }

  return { cx, cz, x: origin.x, z: origin.z, biome, props, spawnPoints, grass };
}

/**
 * Active chunks within `radius` (in chunks) around world position (x,z).
 * radius 2 means 5x5 = 25 chunks. Returns sorted keys for determinism.
 * @param {number} x
 * @param {number} z
 * @param {number} radius - chunk radius, default 2
 * @param {number|string} seed - kept for signature parity, not used for selection
 * @returns {string[]} chunk keys
 */
export function activeChunksForPos(x, z, radius = 2, seed = 0) {
  const { cx, cz } = worldToChunk(x, z);
  const out = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      out.push(chunkKey(cx + dx, cz + dz));
    }
  }
  out.sort();
  return out;
}

/**
 * All chunks that are in `next` but not in `prev` (to load), and vice versa (to unload).
 * @param {string[]} prevKeys
 * @param {string[]} nextKeys
 * @returns {{ toLoad:string[], toUnload:string[] }}
 */
export function diffChunks(prevKeys, nextKeys) {
  const prevSet = new Set(prevKeys);
  const nextSet = new Set(nextKeys);
  const toLoad = nextKeys.filter((k) => !prevSet.has(k));
  const toUnload = prevKeys.filter((k) => !nextSet.has(k));
  return { toLoad, toUnload };
}

/**
 * Level-scaled enemy count for a chunk (WorldRoom helper). Pure so both sides agree.
 * Base 1 per chunk + 1 per 3 player levels, capped by pool.
 * @param {number} playerLevel
 * @returns {number}
 */
export function enemiesForLevel(playerLevel) {
  const lvl = Math.max(1, Math.floor(playerLevel));
  const base = 1;
  const extra = Math.floor((lvl - 1) / 3);
  return Math.min(base + extra, SERVER.enemy?.pool ?? 10);
}
