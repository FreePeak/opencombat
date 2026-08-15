// Low-poly sword built from primitives and attached to the right wrist
// bone of a cloned character. The Quaternius GLBs ship without weapons —
// the Sword_Slash animation would just wave an empty hand around.
//
// Bone-space notes (learned the hard way, keep in sync with reality):
//  - The glTF JSON names the bone "Wrist.R", but GLTFLoader sanitizes node
//    names, so at runtime it is "WristR".
//  - CharacterArmature is scaled x100: a bone child must be scaled 0.01,
//    and any LOCAL offset/position is multiplied ~100x in world space —
//    keep the sword group at (0,0,0) relative to the bone (the grip sits
//    at the group origin, so the fist holds the grip).
import * as THREE from 'three';

const STEEL = new THREE.MeshStandardMaterial({ color: 0xcfd8dc, metalness: 0.85, roughness: 0.3 });
const GUARD = new THREE.MeshStandardMaterial({ color: 0xffb300, metalness: 0.6, roughness: 0.4 });
const GRIP = new THREE.MeshStandardMaterial({ color: 0x4e342e, roughness: 0.9 });

/** Sword built along +Y: grip at the origin, blade pointing up. */
export function buildSword() {
  const sword = new THREE.Group();

  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.72, 0.018), STEEL);
  blade.position.y = 0.5;
  sword.add(blade);

  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.12, 4), STEEL);
  tip.position.y = 0.92;
  tip.rotation.y = Math.PI / 4;
  sword.add(tip);

  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.05), GUARD);
  guard.position.y = 0.12;
  sword.add(guard);

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.025, 0.14, 8), GRIP);
  grip.position.y = 0.04;
  sword.add(grip);

  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), GUARD);
  pommel.position.y = -0.04;
  sword.add(pommel);

  sword.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return sword;
}

/**
 * Attach a sword to the right wrist bone of a (cloned) character mesh.
 * Identity rotation: the blade lies along the wrist's local +Y (fingers
 * direction) — in the bind pose that reads as held at the side.
 * Returns the sword group (null when no right wrist bone was found).
 */
export function attachSword(mesh) {
  let wrist = null;
  mesh.traverse((o) => {
    if (!wrist && o.isBone && /^wrist[._]?r$/i.test(o.name)) wrist = o;
  });
  if (!wrist) return null;
  const sword = buildSword();
  sword.scale.setScalar(0.01); // bones are x100 — see file header
  wrist.add(sword);
  return sword;
}
