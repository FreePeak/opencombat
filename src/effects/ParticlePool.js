// Pooled particle system (Upgrade C/F): ONE THREE.Points object with a
// fixed buffer, reused by every burst — no geometry is created per burst.
// Particles are hidden by parking them far below the ground; a tiny
// shader fades each particle's alpha and shrinks its point size over life.
import * as THREE from 'three';

const VERT = `
attribute vec3 aColor;
attribute float aAlpha;
attribute float aSize;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (180.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  gl_FragColor = vec4(vColor, vAlpha * (1.0 - d * 1.5));
}`;

export default class ParticlePool {
  /**
   * @param {THREE.Scene} scene
   * @param {number} count  total particle slots (pool size)
   */
  constructor(scene, count = 256) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.life = new Float32Array(count);      // seconds left
    this.maxLife = new Float32Array(count);
    this.colors = new Float32Array(count * 3);
    this.alphas = new Float32Array(count);
    this.sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) this.positions[i * 3 + 1] = -999; // parked

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  /** Activate the next `count` free slots as a burst at `pos`. */
  spawnBurst(pos, colorHex, count = 24, speed = 5, life = 0.7) {
    const color = new THREE.Color(colorHex);
    let spawned = 0;
    for (let i = 0; spawned < count && i < this.count * 2; i++) {
      const slot = (this.spawnIdx = (this.spawnIdx ?? 0) + 1) % this.count;
      if (this.life[slot] > 0) continue; // busy slot — try the next one
      this.life[slot] = life;
      this.maxLife[slot] = life;
      this.positions[slot * 3] = pos.x;
      this.positions[slot * 3 + 1] = pos.y;
      this.positions[slot * 3 + 2] = pos.z;
      const a = Math.random() * Math.PI * 2;   // horizontal fan
      const b = Math.random() * Math.PI - Math.PI / 2; // up-ish cone
      const v = speed * (0.5 + Math.random());
      this.velocities[slot * 3] = Math.cos(a) * Math.cos(b) * v;
      this.velocities[slot * 3 + 1] = Math.abs(Math.sin(b)) * v + 2;
      this.velocities[slot * 3 + 2] = Math.sin(a) * Math.cos(b) * v;
      this.colors[slot * 3] = color.r;
      this.colors[slot * 3 + 1] = color.g;
      this.colors[slot * 3 + 2] = color.b;
      this.sizes[slot] = 0.5 + Math.random() * 0.7;
      spawned++;
    }
    this.positions.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.alphas.needsUpdate = true;
    this.sizes.needsUpdate = true;
  }

  /** Advance all live particles; gravity pulls them down, alpha fades. */
  update(dt) {
    let any = false;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.positions[i * 3 + 1] = -999; // park it
        this.alphas[i] = 0;
        continue;
      }
      this.velocities[i * 3 + 1] -= 9 * dt; // gravity
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      this.alphas[i] = this.life[i] / this.maxLife[i];
    }
    if (any) {
      this.positions.needsUpdate = true;
      this.alphas.needsUpdate = true;
    }
  }
}
