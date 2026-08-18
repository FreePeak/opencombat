/**
 * Mobile touch overlay — floating analog joystick (left) + action buttons
 * (right) + mute (bottom-center).  Shown only on touch-capable devices or
 * when `?touch=1` is in the URL.  Pure Pointer Events (unified mouse/touch)
 * with `setPointerCapture` for reliable drag-out-of-zone tracking.
 *
 * Output contract (written every frame on `scene`):
 *   scene.touchStick = { x: number, z: number }  — screen-relative,
 *     y-up, magnitude ≤ 1, zero when idle / inside deadzone.
 *
 * Action buttons store intent in private flags; update() merges them into
 * `scene.keys.j/k/l` at the start of each frame so Player.update() sees
 * a consistent snapshot (no races with edge consumption).
 */
export default class TouchControls {
  static DEADZONE = 0.15;
  static STICK_RADIUS = 60;   // CSS px, knob travel
  static BASE_RADIUS = 40;    // CSS px, base ring
  static STICK_ZONE_W = 0.45; // fraction of viewport width (left half)
  static STICK_ZONE_H = 0.70; // fraction of viewport height (bottom)

  /**
   * Pure math — unit-testable in Node with no DOM.
   * @param {number} dx  pointer offset X from touch-down (px, positive = right)
   * @param {number} dy  pointer offset Y from touch-down (px, positive = down)
   * @param {number} radius  max travel in px
   * @param {number} deadzone  0–1 fraction of radius
   * @returns {{ x: number, y: number, mag: number }}  screen-space axes, y-up, mag ∈ [0,1]
   */
  static stickAxes(dx, dy, radius, deadzone) {
    const mag = Math.min(Math.hypot(dx, dy) / radius, 1);
    if (mag <= deadzone) return { x: 0, y: 0, mag: 0 };
    const norm = (mag - deadzone) / (1 - deadzone);
    return {
      x: (dx / (mag * radius)) * norm,
      y: -(dy / (mag * radius)) * norm, // screen down → y negative (world up = positive)
      mag: norm
    };
  }

  /** @param {import('../scenes/GameScene.js').default} scene */
  constructor(scene) {
    this.scene = scene;
    this.active = false;

    // ── DOM root ──────────────────────────────────────────────────────
    this.root = document.createElement('div');
    this.root.id = 'touch-controls';
    this.root.innerHTML = `
      <div id="tc-stick-zone">
        <div id="tc-base" class="tc-ring"></div>
        <div id="tc-knob" class="tc-ring"></div>
      </div>
      <div id="tc-buttons">
        <button id="tc-block" class="tc-btn" aria-label="Block">🛡</button>
        <button id="tc-attack" class="tc-btn tc-btn-primary" aria-label="Attack">⚔</button>
        <button id="tc-skill" class="tc-btn" aria-label="Skill">✨</button>
      </div>
      <button id="tc-mute" class="tc-btn tc-btn-small" aria-label="Mute">🔊</button>
    `;
    document.body.appendChild(this.root);

    // Cache DOM refs
    this.stickZone = this.root.querySelector('#tc-stick-zone');
    this.base      = this.root.querySelector('#tc-base');
    this.knob      = this.root.querySelector('#tc-knob');
    this.blockBtn  = this.root.querySelector('#tc-block');
    this.attackBtn = this.root.querySelector('#tc-attack');
    this.skillBtn  = this.root.querySelector('#tc-skill');
    this.muteBtn   = this.root.querySelector('#tc-mute');

    // ── Pointer state (joystick) ──────────────────────────────────────
    this._stickPtr = null;
    this._stickOrigin = { x: 0, y: 0 };

    // ── Button intent (private flags — merged into keys at update) ─────
    this._attackHeld = false;
    this._skillHeld  = false;
    this._blockHeld  = false;

    this._bindStick();
    this._bindButtons();
    this._bindMute();

    // Touch detection
    const isTouch =
      matchMedia('(pointer: coarse)').matches ||
      navigator.maxTouchPoints > 0 ||
      location.search.includes('touch=1');
    if (!isTouch) return;
    this.active = true;
  }

  // ── Joystick ────────────────────────────────────────────────────────

  _bindStick() {
    const zone = this.stickZone;

    zone.addEventListener('pointerdown', (e) => {
      if (this._stickPtr !== null) return;
      e.preventDefault();
      e.stopPropagation();
      zone.setPointerCapture(e.pointerId);
      this._stickPtr = e.pointerId;
      this._stickOrigin.x = e.clientX;
      this._stickOrigin.y = e.clientY;
      this.base.style.left = e.clientX + 'px';
      this.base.style.top  = e.clientY + 'px';
      this.base.classList.add('tc-visible');
      this.knob.classList.add('tc-visible');
      this._moveKnob(e.clientX, e.clientY);
    });

    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._stickPtr) return;
      e.preventDefault();
      this._moveKnob(e.clientX, e.clientY);
    });

    const release = (e) => {
      if (e.pointerId !== this._stickPtr) return;
      this._stickPtr = null;
      this.base.classList.remove('tc-visible');
      this.knob.classList.remove('tc-visible');
      this.scene.touchStick = null;
    };
    zone.addEventListener('pointerup',    release);
    zone.addEventListener('pointercancel', release);
    zone.addEventListener('lostpointercapture', release);
  }

  _moveKnob(cx, cy) {
    const dx = cx - this._stickOrigin.x;
    const dy = cy - this._stickOrigin.y;
    const r  = TouchControls.STICK_RADIUS;
    const clamped = Math.min(Math.hypot(dx, dy), r);
    const angle = Math.atan2(dy, dx);
    this.knob.style.left = (this._stickOrigin.x + Math.cos(angle) * clamped) + 'px';
    this.knob.style.top  = (this._stickOrigin.y + Math.sin(angle) * clamped) + 'px';

    const axes = TouchControls.stickAxes(dx, dy, r, TouchControls.DEADZONE);
    this.scene.touchStick = axes.mag > 0 ? { x: axes.x, z: axes.y } : null;
  }

  // ── Action buttons ──────────────────────────────────────────────────

  _bindButtons() {
    this._bindBtn(this.attackBtn, 'attack');
    this._bindBtn(this.skillBtn,  'skill');
    this._bindBtn(this.blockBtn,  'block');
  }

  /**
   * Stores intent in private flags — does NOT write directly to keys,
   * so there is no race with Player.update()'s edge consumption.
   * The flags are merged into scene.keys.j/k/l at the start of update().
   */
  _bindBtn(el, action) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (action === 'attack') this._attackHeld = true;
      if (action === 'skill')  this._skillHeld  = true;
      if (action === 'block')  this._blockHeld  = true;
    });
    el.addEventListener('pointerup', (e) => {
      e.preventDefault();
      if (action === 'attack') this._attackHeld = false;
      if (action === 'skill')  this._skillHeld  = false;
      if (action === 'block')  this._blockHeld  = false;
    });
    el.addEventListener('pointercancel', () => {
      if (action === 'attack') this._attackHeld = false;
      if (action === 'skill')  this._skillHeld  = false;
      if (action === 'block')  this._blockHeld  = false;
    });
  }

  // ── Mute ────────────────────────────────────────────────────────────

  _bindMute() {
    this.muteBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.scene.sound.init();
      const muted = this.scene.sound.toggleMute();
      this.muteBtn.textContent = muted ? '🔇' : '🔊';
    });
  }

  // ── Per-frame (called from GameScene.update) ────────────────────────

  /**
   * Merges touch button intent into `scene.keys` at the start of each
   * frame, so Player.update() sees a consistent snapshot.  Edge-triggered
   * buttons (attack, skill) set `justPressed` on the rising edge only;
   * held buttons (block) track `isDown` continuously.
   */
  update() {
    if (!this.active) return;
    const keys = this.scene.keys;

    // Block: held state (no edge)
    keys.l.isDown = this._blockHeld;

    // Attack: edge-triggered, only on the frame the button goes down
    if (this._attackHeld && !this._attackPrev) keys.j.justPressed = true;
    this._attackPrev = this._attackHeld;

    // Skill: edge-triggered
    if (this._skillHeld && !this._skillPrev) keys.k.justPressed = true;
    this._skillPrev = this._skillHeld;
  }

  // ── Show / hide ─────────────────────────────────────────────────────

  show() {
    if (this.active) this.root.classList.add('tc-active');
  }

  hide() {
    this.root.classList.remove('tc-active');
  }
}
