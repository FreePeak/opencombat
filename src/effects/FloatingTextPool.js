import * as THREE from 'three';

// Pooled floating damage numbers (Upgrade C): a fixed set of HTML divs
// that rise + fade above their victim. Each frame the scene re-projects
// the stored 3D position to screen space, so the numbers track the target
// while it moves. No DOM nodes are created after the pool is built.
export default class FloatingTextPool {
  /** @param {HTMLElement} parent  container the divs live in */
  constructor(parent, size = 24) {
    this.size = size;
    this.items = [];
    this.next = 0;
    for (let i = 0; i < size; i++) {
      const div = document.createElement('div');
      div.className = 'float-text';
      div.style.display = 'none';
      parent.appendChild(div);
      this.items.push({ div, life: 0, maxLife: 0.9, x: 0, y: 0, z: 0, rise: 0, v: new THREE.Vector3() });
    }
  }

  /** Spawn a number at a world position (picked up from the pool). */
  spawn(x, y, z, text, color = '#ffffff') {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.size;
    it.life = it.maxLife;
    it.x = x; it.y = y; it.z = z;
    it.rise = 0;
    it.div.textContent = text;
    it.div.style.color = color;
    it.div.style.display = 'block';
  }

  /**
   * Per-frame update: project each live number and advance its rise/fade.
   * @param {THREE.PerspectiveCamera} camera
   */
  update(dt, camera, width, height) {
    for (const it of this.items) {
      if (it.life <= 0) continue;
      it.life -= dt;
      it.rise += dt * 1.2;
      if (it.life <= 0) {
        it.div.style.display = 'none';
        continue;
      }
      // Project the world position (plus rise offset) to screen space.
      it.div.style.display = 'block';
      const v = it.v;
      v.set(it.x, it.y + it.rise, it.z);
      v.project(camera);
      const cx = (v.x * 0.5 + 0.5) * width;
      const cy = (-v.y * 0.5 + 0.5) * height;
      // Behind the camera -> hide.
      if (v.z > 1 || cx < 0 || cx > width || cy < 0 || cy > height) {
        it.div.style.display = 'none';
        continue;
      }
      it.div.style.transform = `translate(-50%, -50%) translate(${cx}px, ${cy}px)`;
      it.div.style.opacity = Math.min(1, it.life / (it.maxLife * 0.5));
    }
  }
}
