// Unit test for TouchControls.stickAxes — pure math, no DOM, no three.js.
import assert from 'node:assert/strict';
import TouchControls from '../src/ui/TouchControls.js';

const { DEADZONE, STICK_RADIUS } = TouchControls;

// --- inside deadzone → zero output ------------------------------------
{
  const a = TouchControls.stickAxes(2, 3, STICK_RADIUS, DEADZONE);
  assert.equal(a.x, 0, 'small offset inside deadzone → x = 0');
  assert.equal(a.y, 0, 'small offset inside deadzone → y = 0');
  assert.equal(a.mag, 0, 'small offset inside deadzone → mag = 0');
}

// --- full deflection → magnitude = 1 ---------------------------------
{
  const a = TouchControls.stickAxes(STICK_RADIUS, 0, STICK_RADIUS, DEADZONE);
  assert.ok(Math.abs(a.x - 1) < 1e-6, 'full right → x ≈ 1');
  assert.ok(Math.abs(a.mag - 1) < 1e-6, 'full right → mag ≈ 1');
}

// --- partial deflection (beyond deadzone) → clamped, normalized ------
{
  const a = TouchControls.stickAxes(STICK_RADIUS * 0.6, 0, STICK_RADIUS, DEADZONE);
  assert.ok(a.mag > 0 && a.mag < 1, 'partial deflection → 0 < mag < 1');
  // y should be 0 (pure horizontal)
  assert.ok(Math.abs(a.y) < 1e-6, 'horizontal input → y ≈ 0');
}

// --- screen down → y negative (world up = positive) ------------------
{
  const a = TouchControls.stickAxes(0, STICK_RADIUS, STICK_RADIUS, DEADZONE);
  assert.ok(Math.abs(a.x) < 1e-6, 'pure vertical → x ≈ 0');
  assert.ok(a.y < 0, 'screen down → y negative');
  assert.ok(Math.abs(a.mag - 1) < 1e-6, 'full deflection → mag ≈ 1');
}

// --- clamping: overshoot stays at mag = 1 ----------------------------
{
  const big = STICK_RADIUS * 5;
  const a = TouchControls.stickAxes(big, big, STICK_RADIUS, DEADZONE);
  assert.ok(Math.abs(a.mag - 1) < 1e-6, 'overshoot → mag = 1 (clamped)');
  // direction should be 45° diagonal (x positive, y negative, equal magnitude)
  assert.ok(Math.abs(a.x - (-a.y)) < 1e-6, '45° overshoot → x ≈ |y|');
}

// --- diagonal full → both axes at full magnitude ----------------------
{
  const a = TouchControls.stickAxes(STICK_RADIUS, STICK_RADIUS, STICK_RADIUS, DEADZONE);
  assert.ok(Math.abs(a.x - 1) < 1e-6, 'full diagonal → x ≈ 1');
  assert.ok(Math.abs(Math.abs(a.y) - 1) < 1e-6, 'full diagonal → |y| ≈ 1');
  // Note: hypot(x,y) > 1 on diagonals is intentional — the server clamps
  // the world-space direction magnitude to ≤ 1.
}

console.log('touch.test.mjs — all passed');
