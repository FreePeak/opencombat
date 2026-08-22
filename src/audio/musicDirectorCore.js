// Adaptive Music Director — PURE core (P2.9): tier selection + quantization
// math with an injected clock. No AudioContext, no DOM — headlessly testable.
// The WebAudio binding lives in src/audio/MusicDirector.js and feeds this
// module's decisions into layer gain crossfades.
//
// Tier ladder (PRD-music-director.md):
//   0 calm   — lobby/countdown/gameover: pad only
//   1 explore— playing, healthy, no elite
//   2 combat — playing, hurt recently or low hp
//   3 threat — elite alive or recent streak milestone (riser on entry)

export const TIERS = { CALM: 0, EXPLORE: 1, COMBAT: 2, THREAT: 3 };

export const RULES = {
  LOW_HP_PCT: 0.66,
  DAMAGE_WINDOW_MS: 4000,
  MILESTONE_WINDOW_MS: 6000,
  MIN_HOLD_MS: 1200,
};

// inputs: { matchState, paused, hpPct, lastDamageAt, eliteActive, lastMilestoneAt }
// state:  { tier, sinceChangeAt }  (mutated copy returned; pure otherwise)
// now:    ms clock
export function decideTier(inputs, state, now) {
  const target = targetTier(inputs, now);
  // Paused freezes the director at its current tier (null target).
  if (target === null) return { ...state };
  // Hysteresis: a freshly-chosen tier holds for MIN_HOLD_MS before demotion…
  if (
    target < state.tier &&
    now - state.sinceChangeAt < RULES.MIN_HOLD_MS
  ) {
    return { ...state };
  }
  if (target !== state.tier) {
    return { tier: target, sinceChangeAt: now };
  }
  return { ...state };
}

function targetTier({ matchState, paused, hpPct = 1, lastDamageAt = -Infinity,
                      eliteActive = false, lastMilestoneAt = -Infinity }, now) {
  if (paused) return null; // caller keeps current tier (freeze)
  if (matchState !== 'playing') return TIERS.CALM;
  const hurtRecently =
    Number.isFinite(lastDamageAt) && now - lastDamageAt <= RULES.DAMAGE_WINDOW_MS;
  const milestoneRecent =
    Number.isFinite(lastMilestoneAt) && now - lastMilestoneAt <= RULES.MILESTONE_WINDOW_MS;
  if (eliteActive || milestoneRecent) return TIERS.THREAT;
  if (hpPct <= RULES.LOW_HP_PCT || hurtRecently) return TIERS.COMBAT;
  return TIERS.EXPLORE;
}

// Next bar boundary strictly after `now` given a fixed bar length. Handles
// the wraparound case (now exactly on a boundary → next one).
export function nextBarBoundary(barMs, now) {
  if (!(barMs > 0)) throw new Error('barMs must be positive');
  const phase = now % barMs;
  return phase === 0 ? now + barMs : now + (barMs - phase);
}

// True when a transition may fire: we are at/after the quantized boundary and
// hysteresis hold has elapsed. Used by the binding to gate crossfade starts.
export function transitionDue(targetTier, state, barMs, now) {
  if (targetTier === state.tier) return false;
  if (now - state.sinceChangeAt < RULES.MIN_HOLD_MS) return false;
  return now >= nextBarBoundary(barMs, state.sinceChangeAt);
}
