// Low-poly weapons: primitives or loaded GLB props, attached to a cloned
// character's hand bones. The Quaternius character GLBs ship without weapons
// — the Sword_Slash animation would just wave an empty hand around. The
// knight (swordsman) ships NO animation clips at all, so this module also
// provides ProceduralAnim: a bob + weapon-swing fallback that keeps
// clip-less models visually alive.
//
// Bone-space notes (learned the hard way, keep in sync with reality):
//  - The glTF JSON names the bone "Wrist.R" on Quaternius rigs, but the
//    Dawid2K knight uses "Hand.R"; GLTFLoader sanitizes node names, so at
//    runtime they read "WristR" / "HandR". Match both.
//  - Character armatures are scaled x100: a bone child must be scaled 0.01,
//    and any LOCAL offset/position is multiplied ~100x in world space —
//    keep weapon groups at (0,0,0) relative to the bone (the grip sits at
//    the group origin, so the fist holds the grip).
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

/** First bone whose (sanitized) name matches `re`, or null. */
function findBone(mesh, re) {
  let bone = null;
  mesh.traverse((o) => {
    if (!bone && o.isBone && re.test(o.name)) bone = o;
  });
  return bone;
}

export const RIGHT_HAND = /^(wrist|hand)[._]?r$/i;
export const LEFT_HAND = /^(wrist|hand)[._]?l$/i;

/**
 * Attach a loaded weapon GLB (e.g. assets/props/sword.glb) to the right hand.
 * The GLB is shared; clone() is enough (static mesh, no skin). `scale` is the
 * child scale under the x100 bone — 0.0037 turns the 2.73-unit sword prop
 * into a ~1.0-unit blade in world space.
 */
export function attachModelSword(mesh, model, scale = 0.0037) {
  const hand = findBone(mesh, RIGHT_HAND);
  if (!hand || !model) return null;
  const sword = model.clone();
  sword.scale.setScalar(scale);
  hand.add(sword);
  sword.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return sword;
}

/** Low-poly bow built along +Y (grip at origin), like buildSword. */
export function buildBow() {
  const bow = new THREE.Group();
  const WOOD = new THREE.MeshStandardMaterial({ color: 0x6d4c41, roughness: 0.8 });
  const STRING = new THREE.MeshBasicMaterial({ color: 0xe0e0e0 });

  const arc = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.025, 6, 12, Math.PI * 0.9), WOOD);
  arc.rotation.z = Math.PI / 2 - Math.PI * 0.45; // arc opens toward +Z (away from holder)
  bow.add(arc);

  const string = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.86, 4), STRING);
  string.position.z = 0.055;
  bow.add(string);

  bow.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return bow;
}

/** Attach a procedural bow to the LEFT hand (right hand stays free to swing). */
export function attachBow(mesh) {
  const hand = findBone(mesh, LEFT_HAND);
  if (!hand) return null;
  const bow = buildBow();
  bow.scale.setScalar(0.01); // bones are x100 — see file header
  hand.add(bow);
  return bow;
}

/**
 * Weapon dispatch per character def (see CONFIG.characters):
 *  - 'sword': the loaded Quaternius sword GLB (falls back to buildSword)
 *  - 'bow'  : procedural bow on the left hand
 *  - null   : the model carries its own weapon (mage staff, demon trident)
 */
export function attachWeapon(mesh, def, swordModel) {
  if (def?.weapon === 'sword') return attachModelSword(mesh, swordModel) || attachSword(mesh);
  if (def?.weapon === 'bow') return attachBow(mesh);
  return null;
}

/**
 * Procedural idle/run/swing for models without animation clips (the knight).
 * Bob the root vertically and rotate the weapon on attack so the character
 * reads as alive; amplitude/speed are tiny so it never fights the lerp.
 */
export class ProceduralAnim {
  constructor(root, weapon) {
    this.root = root;
    this.weapon = weapon;
    this.t = Math.random() * 10; // desync identical models
    this.swingT = 0;
  }

  /** moving/attacking are booleans per frame; dt is the clamped frame delta. */
  update(dt, moving, attacking) {
    this.t += dt * (moving ? 11 : 2.2);
    const amp = moving ? 0.045 : 0.015;
    this.root.position.y = Math.abs(Math.sin(this.t)) * amp;
    if (attacking && this.swingT <= 0) this.swingT = 0.35;
    this.swingT = Math.max(0, this.swingT - dt);
    if (this.weapon) {
      const k = this.swingT > 0 ? 1 - this.swingT / 0.35 : 0; // 0..1 over the swing
      // Swing: full chop (-1.9 rad).  Idle/run: keep the sword in a
      // "drawn" resting pose (-0.25 rad) so the arm never drops back to
      // the sheathed zero — the sword stays visibly held between swings.
      this.weapon.rotation.x = this.swingT > 0
        ? -Math.sin(k * Math.PI) * 1.9
        : -0.25;
    }
  }
}
