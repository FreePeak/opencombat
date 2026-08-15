// Entry point: owns the render loop. Everything else lives in GameScene.
import GameScene from './scenes/GameScene.js';

const scene = new GameScene(document.getElementById('game'));
scene.init();
window.__gameScene = scene; // [DEBUG-vis1] e2e probe handle

let last = performance.now();
let running = true;

function frame(now) {
  requestAnimationFrame(frame);
  if (!running) return; // tab hidden: skip sim + render entirely
  // Clamp the delta: after a background tab / devtools pause the first
  // frame would otherwise simulate a huge step (and lerps would overshoot).
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  scene.update(dt, now / 1000);
}
requestAnimationFrame(frame);

// Upgrade F: pause on hidden tab, resume on visible (saves battery/GPU).
document.addEventListener('visibilitychange', () => {
  running = document.visibilityState === 'visible';
  if (running) last = performance.now(); // avoid a giant dt on resume
});
