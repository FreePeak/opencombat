// Transient skill visuals (Phase 3): the knight's flying sword slash, the
// bash shockwave ring at the dash landing, and chain-lightning arcs hopping
// caster -> target -> target. Everything here is cosmetic — the server owns
// the damage; this module just makes the casts readable in the world.
import * as THREE from 'three';

const FADE_S = 0.28;   // slash / ring lifetime
const ARC_S = 0.35;    // chain arc lifetime

export default class SkillFx {
  constructor(scene) {
    this.scene = scene;
    this.items = []; // { group, t, life, kind, update?(k) }
  }

  /**
   * Crescent "flying sword slash": a partial ring laid flat at chest height,
   * centered on the character's facing, expanding + fading. Called on every
   * knight attack (small) and bash cast (large).
   */
  slash(pos, rotY, color = 0xffffff, scale = 1) {
    const arc = Math.PI * 0.9; // ~160° crescent
    // thetaStart centers the arc on the group's local +Z after the flat
    // rotation (see class note): -90° is forward, minus half the arc.
    const geo = new THREE.RingGeometry(0.7 * scale, 1.15 * scale, 24, 1,
      -Math.PI / 2 - arc / 2, arc);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2; // lay flat (XY -> XZ)
    const group = new THREE.Group();
    group.add(mesh);
    group.position.set(pos.x, 1.0, pos.z);
    group.rotation.y = rotY;
    this.scene.add(group);
    this.items.push({
      group, t: 0, life: FADE_S,
      tick: (k) => { group.scale.setScalar(1 + k * 1.6); mat.opacity = 0.9 * (1 - k); }
    });
  }

  /**
   * Expanding ground ring — the bash landing shockwave (and any AoE pulse).
   */
  ring(pos, color = 0xffd54f, maxR = 3) {
    const geo = new THREE.RingGeometry(0.55, 0.8, 28);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, 0.12, pos.z);
    this.scene.add(mesh);
    this.items.push({
      group: mesh, t: 0, life: FADE_S,
      tick: (k) => { mesh.scale.setScalar(1 + k * maxR); mat.opacity = 0.85 * (1 - k); }
    });
  }

  /**
   * Chain-lightning arcs: `points` is the hop path (caster first, then each
   * chained target in order). Each hop is drawn as 3 jittered sub-segments —
   * thin additive boxes oriented along the segment — that flash and fade.
   */
  chain(points, color = 0xce93d8) {
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const segs = 3;
      let prev = { x: a.x, y: 1.0, z: a.z };
      for (let s = 1; s <= segs; s++) {
        const end = {
          x: a.x + (b.x - a.x) * (s / segs) + (s < segs ? (Math.random() - 0.5) * 1.1 : 0),
          y: 1.0 + (s < segs ? (Math.random() - 0.5) * 0.7 : 0),
          z: a.z + (b.z - a.z) * (s / segs) + (s < segs ? (Math.random() - 0.5) * 1.1 : 0)
        };
        this._arcSegment(prev, end, color, i * 0.06); // slight stagger per hop
        prev = end;
      }
    }
  }

  /** One jagged lightning sub-segment (thin box, additive, quick fade). */
  _arcSegment(a, b, color, delay) {
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (len < 1e-4) return;
    const geo = new THREE.BoxGeometry(0.07, 0.07, len);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    mesh.lookAt(b.x, b.y, b.z); // +Z faces the target
    this.scene.add(mesh);
    this.items.push({
      group: mesh, t: -delay, life: ARC_S,
      tick: (k) => { mat.opacity = 0.95 * (1 - k); }
    });
  }

  /** Advance every live effect; remove + dispose finished ones. */
  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      if (it.t < 0) { it.group.visible = false; continue; } // staggered start
      it.group.visible = true;
      const k = it.t / it.life;
      if (k >= 1) {
        this.scene.remove(it.group);
        it.group.traverse?.((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
        this.items.splice(i, 1);
        continue;
      }
      it.tick(k);
    }
  }
}
