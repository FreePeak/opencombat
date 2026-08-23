// Low-HP danger vignette (FR-HUD-02): pure intensity evaluator for the
// persistent danger overlay shown while the local player is critically hurt.
// Zero imports, no DOM — the client reads {on, intensity} and styles #danger.
//
// Ramp: danger turns ON at exactly 30% hp with intensity 0 and grows linearly
// to 1 at 5% hp, clamped beyond. Dead (hp <= 0) or degenerate inputs are off.

const ON_AT = 0.30; // hp/maxHp fraction where the vignette arms
const FULL_AT = 0.05; // fraction where intensity saturates at 1

/**
 * @param {number} hp current hit points
 * @param {number} maxHp maximum hit points
 * @returns {{on: boolean, intensity: number}} 0 <= intensity <= 1
 */
export function lowHpFx(hp, maxHp) {
  const max = Number(maxHp);
  const cur = Number(hp);
  if (!Number.isFinite(max) || !Number.isFinite(cur) || max <= 0 || cur <= 0) {
    return { on: false, intensity: 0 };
  }
  const frac = cur / max;
  if (frac > ON_AT) return { on: false, intensity: 0 }; // armed AT 30%, not before
  const t = (ON_AT - frac) / (ON_AT - FULL_AT);
  const intensity = Math.max(0, Math.min(1, t));
  return { on: true, intensity };
}
