// Client-side chunk streaming manager — load radius 2, InstancedMesh for perf.
// Deterministic via src/shared/worldgen.js so server and client agree on biomes/props without syncing them.

import * as THREE from 'three';
import { generateChunk, activeChunksForPos, diffChunks, CHUNK_SIZE, biomeColor } from '../shared/worldgen.js';

export class ChunkManager {
  constructor(scene, worldSeed = 1337) {
    this.scene = scene;
    this.worldSeed = worldSeed;
    this.radius = 2; // load radius 2 => 5x5 = 25 chunks
    this.loaded = new Map(); // key -> { chunk, group, meshes }
    this.activeKeys = [];
    this.tempo = 0; // throttle updates
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
    for (const [type, list] of byType) {
      const count = list.length;
      if (count === 0) continue;
      // Simple placeholder geometry per type (real assets via GLTF would be InstancedMesh too, but keep zero-build)
      let geo;
      if (type === 'tree' || type === 'dead_tree') {
        geo = new THREE.ConeGeometry(0.6, 2.2, 6);
      } else { // rock
        geo = new THREE.DodecahedronGeometry(0.5, 0);
      }
      const instMat = new THREE.MeshStandardMaterial({
        color: type === 'dead_tree' ? 0x5c4a33 : type === 'tree' ? 0x2e7d32 : 0x7a7a7a,
      });
      const inst = new THREE.InstancedMesh(geo, instMat, count);
      inst.castShadow = true;
      inst.receiveShadow = true;
      const dummy = new THREE.Object3D();
      list.forEach((p, i) => {
        dummy.position.set(p.x, 0.5, p.z);
        dummy.rotation.y = p.rot;
        dummy.scale.setScalar(p.scale);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
      meshes.push(inst);
    }

    this.scene.add(group);
    this.loaded.set(key, { chunk, group, meshes });
  }

  unloadChunk(key) {
    const entry = this.loaded.get(key);
    if (!entry) return;
    this.scene.remove(entry.group);
    // Dispose geometries/materials for GC (optional)
    entry.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
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
