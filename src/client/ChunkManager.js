// Client-side chunk streaming manager — load radius 2, InstancedMesh for perf.
// Deterministic via src/shared/worldgen.js so server and client agree on biomes/props without syncing them.

import * as THREE from 'three';
import { generateChunk, activeChunksForPos, diffChunks, CHUNK_SIZE, biomeColor } from '../shared/worldgen.js';
import { makeTuftGeometry, makeTreeGeometry, makeDeadTreeGeometry, makeRockGeometry } from './Grass.js';

// Per-biome grass tint (meadow lush green, dead forest olive, ashland drab).
const GRASS_TINT = {
  meadow: 0x4e9a4e,
  dead_forest: 0x6b6b45,
  ashland: 0x8a8a7a
};

export class ChunkManager {
  constructor(scene, worldSeed = 1337) {
    this.scene = scene;
    this.worldSeed = worldSeed;
    this.radius = 2; // load radius 2 => 5x5 = 25 chunks
    this.loaded = new Map(); // key -> { chunk, group, meshes }
    this.activeKeys = [];
    this.tempo = 0; // throttle updates
    // Shared prop geometry/material (created once, reused by every chunk's
    // InstancedMesh — one draw call per prop type per chunk).
    this.propGeo = {
      tree: makeTreeGeometry(),
      dead_tree: makeDeadTreeGeometry(),
      rock: makeRockGeometry()
    };
    this.propMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    // Grass tufts per biome (shared geometry + material, one draw call per
    // chunk). Shared resources are marked so unloadChunk never disposes them.
    this.tuftMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 1 });
    this.tuft = {};
    for (const [biome, tint] of Object.entries(GRASS_TINT)) {
      this.tuft[biome] = makeTuftGeometry(tint);
    }
    for (const geo of Object.values(this.propGeo)) geo.userData.shared = true;
    this.propMat.userData.shared = true;
    this.tuftMat.userData.shared = true;
    for (const geo of Object.values(this.tuft)) geo.userData.shared = true;
  }

  /** Update streaming based on player world pos (x,z). Call each frame or on move. */
  updateForPos(x, z) {
    const nextKeys = activeChunksForPos(x, z, this.radius, this.worldSeed);
    const { toLoad, toUnload } = diffChunks(this.activeKeys, nextKeys);
    for (const key of toUnload) this.unloadChunk(key);
    for (const key of toLoad) this.loadChunk(key);
    this.activeKeys = nextKeys;
  }

  loadChunk(key) {
    if (this.loaded.has(key)) return;
    const [cx, cz] = key.split(',').map(Number);
    const chunk = generateChunk(cx, cz, this.worldSeed);
    const group = new THREE.Group();
    group.name = `chunk-${key}`;

    // Ground tile (simple plane per chunk, tinted by biome)
    const groundGeo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE);
    const mat = new THREE.MeshStandardMaterial({ color: biomeColor(chunk.biome), roughness: 0.9 });
    const ground = new THREE.Mesh(groundGeo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(chunk.x + CHUNK_SIZE / 2, 0, chunk.z + CHUNK_SIZE / 2);
    ground.receiveShadow = true;
    group.add(ground);

    // Props via InstancedMesh for perf (one InstancedMesh per type)
    const byType = new Map();
    for (const p of chunk.props) {
      if (!byType.has(p.type)) byType.set(p.type, []);
      byType.get(p.type).push(p);
    }

    const meshes = [];
    const dummy = new THREE.Object3D();
    for (const [type, list] of byType) {
      const count = list.length;
      if (count === 0) continue;
      const inst = new THREE.InstancedMesh(this.propGeo[type], this.propMat, count);
      inst.castShadow = true;
      inst.receiveShadow = true;
      list.forEach((p, i) => {
        dummy.position.set(p.x, 0, p.z); // geometries are rooted at y=0
        dummy.rotation.y = p.rot;
        dummy.scale.setScalar(p.scale);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
      meshes.push(inst);
    }

    // Ground cover: one grass InstancedMesh per chunk, biome-tinted, never a
    // shadow caster (ARTWORK_PLAN phase 1 performance budget).
    if (chunk.grass && chunk.grass.length > 0) {
      const tuftGeo = this.tuft[chunk.biome] ?? this.tuft.meadow;
      const grass = new THREE.InstancedMesh(tuftGeo, this.tuftMat, chunk.grass.length);
      grass.name = 'grass';
      grass.castShadow = false;
      grass.receiveShadow = false;
      chunk.grass.forEach((g, i) => {
        dummy.position.set(g.x, 0, g.z);
        dummy.rotation.y = g.rot;
        dummy.scale.setScalar(g.scale);
        dummy.updateMatrix();
        grass.setMatrixAt(i, dummy.matrix);
      });
      grass.instanceMatrix.needsUpdate = true;
      group.add(grass);
      meshes.push(grass);
    }

    this.scene.add(group);
    this.loaded.set(key, { chunk, group, meshes });
  }

  unloadChunk(key) {
    const entry = this.loaded.get(key);
    if (!entry) return;
    this.scene.remove(entry.group);
    // Dispose per-chunk resources for GC — but never the SHARED prop/grass
    // geometries + materials other loaded chunks still reference.
    entry.group.traverse((obj) => {
      if (obj.geometry && !obj.geometry.userData?.shared) obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      for (const m of mats) if (!m.userData?.shared) m.dispose();
    });
    this.loaded.delete(key);
  }

  dispose() {
    for (const key of [...this.loaded.keys()]) this.unloadChunk(key);
    this.activeKeys = [];
  }

  /** Debug: how many chunks currently loaded. */
  get loadedCount() {
    return this.loaded.size;
  }
}
