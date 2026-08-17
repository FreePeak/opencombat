// Entry point: owns the render loop. Everything else lives in GameScene.
// Boot is guarded: WebGL support is detected up front and any boot failure
// (renderer, CDN, models) surfaces in the login overlay instead of a black
// screen. index.html's watchdog uses window.__OPENGAME_BOOTED to detect a
// total load failure (unreachable CDN) and shows an error on its own.
//
// Local mode: when the Colyseus server is unreachable (e.g. GitHub Pages
// static hosting with the tunnel down), GameScene falls back to a
// browser-local simulation that runs the same match lifecycle —
// single-player against the same enemies, orbs and power-ups. The probe
// (serverAvailable) lives in network.js; the fallback room is
// src/LocalRoom.js.
import GameScene from './scenes/GameScene.js';

window.__OPENGAME_BOOTED = true; // set BEFORE any async work below

function showBootError(message) {
  const login = document.getElementById('login');
  const err = document.getElementById('login-error');
  const loading = document.getElementById('loading');
  if (loading) loading.style.display = 'none';
  if (err) { err.textContent = message; err.style.display = 'block'; }
  if (login) login.classList.add('visible');
}

/** WebGL2 is required by three.js 0.185 (WebGL1 support was removed). */
function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

if (!webglAvailable()) {
  showBootError('WebGL is not available in this browser — the game cannot start. Try a recent Chrome/Firefox/Safari or enable hardware acceleration.');
} else {
  try {
    const scene = new GameScene(document.getElementById('game'));
    scene.init();
    // E2E hook: browser tests (test/browser.test.py) probe the live scene via
    // window.__gameScene to assert rendering + movement internals.
    window.__gameScene = scene;

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

    // Pause on hidden tab, resume on visible (saves battery/GPU).
    document.addEventListener('visibilitychange', () => {
      running = document.visibilityState === 'visible';
      if (running) last = performance.now(); // avoid a giant dt on resume
    });
  } catch (err) {
    console.error('[opengame] boot failed:', err);
    showBootError('Failed to start the game: ' + (err?.message || err));
  }
}
