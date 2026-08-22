// GLB nature dressing (ARTWORK_PLAN phase 1 follow-up): scatters the
// downloaded Quaternius-style grass/flower/bush GLBs across the bounded arena
// as InstancedMesh draws, deterministically (own LCG stream, seed 9021 —
// independent from GameScene's 4242 stream so existing placements never shift).
//
// Everything lands inside gameScene.arenaGroup, so enterWorld()'s teardown
// removes it together with the rest of the arena visuals. No shadows: these
// are fill-rate-sensitive ground cover, same call as the procedural tufts.
// Failures are logged and skipped — dressing must never block boot.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CONFIG } from '../config.js';
import { makeLcg, sampleOpenPositions, fitScale } from '../tools/scatter.js';

// Per-asset plan: instance count + normalized target height (meters).
const SET = [
  { file: 'assets/props/grass_tuft_a.glb', count: 60, height: 0.55, maxScale: 3 },
  { file: 'assets/props/grass_tuft_b.glb', count: 60, height: 0.45, maxScale: 3 },
  { file: 'assets/props/grass_tall.glb', count: 40, height: 0.85, maxScale: 3 },
  { file: 'assets/props/flowers_patch.glb', count: 14, height: 0.5, maxScale: 2 },
  { file: 'assets/props/small_plant.glb', count: 16, height: 0.4, maxScale: 2 },
  { file: 'assets/props/bush_a.glb', count: 10, height: 0.9, maxScale: 2 },
  { file: 'assets/props/bushes_patch.glb', count: 6, height: 1.1, maxScale: 2 }
];

/** Bake every mesh of a loaded GLB into [{geometry, material}] at the origin. */
export function bakeMeshes(root) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    geo.userData.shared = true;
    if (o.material) o.material.userData.shared = true;
    parts.push({ geometry: geo, material: o.material });
  });
  return parts;
}

/**
 * Load + scatter the nature set into gameScene.arenaGroup.
 * Resolves with the dressing Group (or null when nothing was added).
 */
export async function dressArena(gameScene) {
  const arenaGroup = gameScene && gameScene.arenaGroup;
  if (!arenaGroup) return null;

  const half = CONFIG.world.size / 2 - 1; // same bound as GameScene.scatterProps
  const safe = 7;                          // same spawn square
  const rng = makeLcg(9021);
  const loader = new GLTFLoader();
  const dummy = new THREE.Object3D();
  const dressing = new THREE.Group();
  dressing.name = 'nature_dressing';

  for (const spec of SET) {
    try {
      const gltf = await loader.loadAsync(spec.file);
      const parts = bakeMeshes(gltf.scene);
      if (!parts.length) continue;
      const bbox = new THREE.Box3().setFromObject(gltf.scene);
      const scale = fitScale({ minY: bbox.min.y, maxY: bbox.max.y }, spec.height, spec.maxScale);
      const spots = sampleOpenPositions(rng, spec.count, half, safe);
      for (const part of parts) {
        const inst = new THREE.InstancedMesh(part.geometry, part.material, spots.length);
        inst.name = 'dressing_' + spec.file.split('/').pop();
        inst.castShadow = false;
        inst.receiveShadow = false;
        spots.forEach(({ x, z }, i) => {
          dummy.position.set(x, 0, z);
          dummy.rotation.y = rng() * Math.PI * 2;
          dummy.scale.setScalar(scale * (0.8 + rng() * 0.5));
          dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix);
        });
        inst.instanceMatrix.needsUpdate = true;
        dressing.add(inst);
      }
    } catch (err) {
      console.warn('[opengame] nature dressing skipped:', spec.file, err?.message || err);
    }
  }

  if (!dressing.children.length) return null;
  arenaGroup.add(dressing);
  return dressing;
}
