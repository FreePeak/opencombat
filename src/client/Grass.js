// Low-poly ground-cover geometry builders (ARTWORK_PLAN phase 1).
// Shared by the bounded-arena dressing (GameScene.scatterProps) and the
// world chunk streamer (ChunkManager) so both surfaces render the same
// style. Everything is vertex-colored and meant for InstancedMesh — one
// draw call per surface — and NEVER a shadow caster (fill-rate, per the
// plan's performance budget).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Paint every vertex of a geometry a solid color (for vertex-color materials). */
function colorize(geo, colorHex) {
  const c = new THREE.Color(colorHex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Merge with a canonical indexing: primitives disagree (Cylinder is
 *  indexed, Icosahedron is not) and mergeGeometries refuses mixed sets. */
function mergeAll(geos) {
  return mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)));
}

/** Grass tuft: two crossed blades standing on y=0. */
export function makeTuftGeometry(colorHex) {
  const blade = new THREE.PlaneGeometry(0.5, 0.45);
  blade.translate(0, 0.225, 0);
  const crossed = blade.clone();
  crossed.rotateY(Math.PI / 2);
  const geo = mergeAll([blade, crossed]);
  colorize(geo, colorHex);
  return geo;
}

/** Flower: slim stem + blossom head, standing on y=0. Blossom vertices are
 *  white so a per-instance tint (instanceColor) colors just the flower. */
export function makeFlowerGeometry() {
  const stem = new THREE.CylinderGeometry(0.02, 0.03, 0.35, 4);
  stem.translate(0, 0.175, 0);
  colorize(stem, 0x3f7d46);
  const blossom = new THREE.IcosahedronGeometry(0.09, 0);
  blossom.translate(0, 0.38, 0);
  colorize(blossom, 0xffffff);
  return mergeAll([stem, blossom]);
}

/** Low-poly tree: trunk + conifer canopy merged into one geometry. */
export function makeTreeGeometry() {
  const trunk = new THREE.CylinderGeometry(0.12, 0.16, 1.0, 5);
  trunk.translate(0, 0.5, 0);
  colorize(trunk, 0x6b4a2f);
  const canopy = new THREE.ConeGeometry(0.65, 1.6, 6);
  canopy.translate(0, 1.5, 0);
  colorize(canopy, 0x2e7d32);
  return mergeAll([trunk, canopy]);
}

/** Bare dead tree: leaning trunk + one branch, no canopy. */
export function makeDeadTreeGeometry() {
  const trunk = new THREE.CylinderGeometry(0.09, 0.18, 1.7, 5);
  trunk.translate(0, 0.85, 0);
  colorize(trunk, 0x5c4a33);
  const branch = new THREE.CylinderGeometry(0.04, 0.07, 0.7, 4);
  branch.translate(0, 0.35, 0);
  branch.rotateZ(0.8);
  branch.translate(0, 1.15, 0);
  colorize(branch, 0x5c4a33);
  return mergeAll([trunk, branch]);
}

/** Weathered boulder (vertex-colored, sits half-buried on y=0). */
export function makeRockGeometry() {
  const geo = new THREE.DodecahedronGeometry(0.5, 0);
  geo.scale(1, 0.75, 1);
  return colorize(geo, 0x7a7a7a);
}

/** Low hedge/bush: rounded clump for arena bounds (ARTWORK_PLAN phase 3). */
export function makeBushGeometry() {
  const geo = new THREE.IcosahedronGeometry(0.65, 0);
  geo.scale(1, 0.7, 1);
  geo.translate(0, 0.45, 0);
  return colorize(geo, 0x2d6a32);
}

// --- Pickup visuals (ARTWORK_PLAN phase 5) ---------------------------------
/** Crystal orb: Icosahedron, vertex-colored via emissive material (not vertex color). */
export function makeOrbGeometry() {
  return new THREE.IcosahedronGeometry(0.45, 1);
}

/** Speed chevrons: triangular cone (arrow) pointing up, flat-shaded. */
export function makeSpeedGeometry() {
  const geo = new THREE.ConeGeometry(0.42, 0.7, 3);
  // Cone points +Y by default; keep upright (arrow shape) — spin shows chevron silhouette.
  return geo;
}

/** Shield bubble: smooth sphere with transparent material. */
export function makeShieldGeometry() {
  return new THREE.SphereGeometry(0.52, 14, 10);
}

/** Double coin stack: two thin cylinders stacked vertically (as Group). */
export function makeDoubleGroup(colorHex) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: colorHex, emissive: colorHex, emissiveIntensity: 0.75, roughness: 0.4, metalness: 0.2 });
  const cylGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.14, 16);
  for (const y of [0.10, 0.30]) {
    const m = new THREE.Mesh(cylGeo, mat);
    m.position.y = y;
    group.add(m);
  }
  // Slight gap, centered around y=0.2 so bob anchor is consistent.
  return group;
}
