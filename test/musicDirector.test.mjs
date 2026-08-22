import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS, RULES, decideTier, nextBarBoundary, transitionDue
} from '../src/audio/musicDirectorCore.js';

const base = { matchState: 'playing', paused: false, hpPct: 1 };

test('tier decision truth table', () => {
  const fresh = () => ({ tier: TIERS.CALM, sinceChangeAt: -Infinity });
  const t0 = 100000;
  // countdown/gameover -> calm
  assert.equal(decideTier({ ...base, matchState: 'countdown' }, fresh(), t0).tier, TIERS.CALM);
  assert.equal(decideTier({ ...base, matchState: 'gameover' }, fresh(), t0).tier, TIERS.CALM);
  // healthy playing -> explore
  assert.equal(decideTier({ ...base }, fresh(), t0).tier, TIERS.EXPLORE);
  // low hp -> combat
  assert.equal(decideTier({ ...base, hpPct: 0.5 }, fresh(), t0).tier, TIERS.COMBAT);
  // recent damage (within window) -> combat even at full hp
  assert.equal(
    decideTier({ ...base, lastDamageAt: t0 - RULES.DAMAGE_WINDOW_MS + 1 }, fresh(), t0).tier,
    TIERS.COMBAT
  );
  // damage outside window -> back to explore
  assert.equal(
    decideTier({ ...base, lastDamageAt: t0 - RULES.DAMAGE_WINDOW_MS - 1 }, fresh(), t0).tier,
    TIERS.EXPLORE
  );
  // elite alive -> threat
  assert.equal(decideTier({ ...base, eliteActive: true }, fresh(), t0).tier, TIERS.THREAT);
  // milestone within 6s -> threat; expired -> explore
  const msState = decideTier(
    { ...base, lastMilestoneAt: t0 - 100 }, fresh(), t0);
  assert.equal(msState.tier, TIERS.THREAT);
  assert.equal(
    decideTier({ ...base, lastMilestoneAt: t0 - RULES.MILESTONE_WINDOW_MS - 1 }, fresh(), t0).tier,
    TIERS.EXPLORE
  );
});

test('hysteresis: demotion held for MIN_HOLD_MS unless paused', () => {
  const t0 = 100000;
  let state = { tier: TIERS.THREAT, sinceChangeAt: t0 };
  // 500ms later target drops to explore -> hold THREAT
  state = decideTier({ ...base }, state, t0 + 500);
  assert.equal(state.tier, TIERS.THREAT);
  // after hold expires -> demote
  state = decideTier({ ...base }, state, t0 + RULES.MIN_HOLD_MS + 1);
  assert.equal(state.tier, TIERS.EXPLORE);
});

test('pause freezes current tier regardless of inputs', () => {
  const t0 = 100000;
  let state = { tier: TIERS.COMBAT, sinceChangeAt: t0 };
  const out = decideTier({ ...base, paused: true, hpPct: 1 }, state, t0 + 99999);
  assert.equal(out.tier, TIERS.COMBAT);
});

test('promotion applies immediately (no hold against upgrades)', () => {
  const t0 = 100000;
  let state = { tier: TIERS.EXPLORE, sinceChangeAt: t0 };
  state = decideTier({ ...base, eliteActive: true }, state, t0 + 10);
  assert.equal(state.tier, TIERS.THREAT);
});

test('nextBarBoundary: strictly-next boundary semantics', () => {
  const bar = 2000;
  assert.equal(nextBarBoundary(bar, 101234), 102000);      // mid-bar -> next edge
  assert.equal(nextBarBoundary(bar, 102000), 104000);      // on-edge -> NEXT one
  assert.equal(nextBarBoundary(bar, 99998), 100000);
});

test('transitionDue gates on tier change, hold expiry and bar edge', () => {
  const bar = 2000;
  const t0 = 100000;
  // same tier -> never due
  let state = { tier: TIERS.COMBAT, sinceChangeAt: t0 };
  assert.equal(transitionDue(TIERS.COMBAT, state, bar, t0 + 5000), false);
  // tier differs but hold active -> not due
  assert.equal(transitionDue(TIERS.EXPLORE, state, bar, t0 + 500), false);
  // hold expired but still before next bar edge (sinceChange at 100000 -> edge 102000)
  assert.equal(nextBarBoundary(bar, t0), 102000);
  assert.equal(transitionDue(TIERS.EXPLORE, { tier: TIERS.COMBAT, sinceChangeAt: t0 }, bar, t0 + 1500), false);
  assert.equal(transitionDue(TIERS.EXPLORE, { tier: TIERS.COMBAT, sinceChangeAt: t0 }, bar, t0 + 2000), true);
});
