// Kill-drop XP orbs (PRD-orb-drops.md): a killing blow charges the nearest
// UNCHARGED roaming orb with the dead enemy's XP value and teleports it to
// the corpse — every kill leaves a physical reward (VS lesson #1), and in
// co-op kill XP becomes a shared field resource instead of an invisible
// number. Collecting pays the charge on top of the base orb payout, then
// the orb reverts and respawn-teleports as always.
//
// Pure module — no imports — mirroring elites.js/archetypes.js so GameRoom,
// LocalRoom and tests share ONE source of truth. The rooms own a Map keyed
// by schema orb objects (the powerUpTimers idiom); this module only does
// math over [orbs, charges]. Positions written here are caller-supplied
// (the corpse), so online/offline parity is structural, not sampled.

/**
 * Charge the nearest uncharged orb for a kill at (x, z).
 *
 * Selection: smallest squared distance to the corpse; index order breaks
 * ties deterministically so both sims pick the same slot given equal orb
 * layouts. The winner teleports to the corpse immediately — reads as the
 * kill popping an orb.
 *
 * @param {Array|ArraySchema} orbs - roaming orb pool, mutated on success
 * @param {Map} charges - orb object -> stored XP amount (rooms own it)
 * @param {number} x - corpse x
 * @param {number} z - corpse z
 * @param {number} amount - XP to store (elite kills pass the doubled value)
 * @returns {boolean} true when an orb was charged; false when every orb is
 *   already charged (caller must fall back to direct grantXp — the economy
 *   never leaks) or when the inputs are degenerate.
 */
export function chargeForKill(orbs, charges, x, z, amount) {
  if (!orbs || !charges || !(amount > 0)) return false;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < orbs.length; i++) {
    const orb = orbs[i];
    if (!orb || charges.has(orb)) continue; // charged orbs are invisible here
    const dx = orb.x - x;
    const dz = orb.z - z;
    const dist = dx * dx + dz * dz;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) return false;
  const orb = orbs[bestIdx];
  orb.x = x;
  orb.z = z;
  orb.charge = amount; // exposed for client rendering (gold pulse)
  charges.set(orb, amount);
  return true;
}

/**
 * Pay out an orb's stored charge on pickup: returns the amount (0 when the
 * orb is uncharged) and deletes the entry so the orb reverts to uncharged
 * before its respawn teleport. Idempotent per pickup — double-drain is a
 * harmless 0.
 */
export function drainCharge(charges, orb) {
  if (!charges || !orb) return 0;
  const amount = charges.get(orb);
  if (!(amount > 0)) {
    charges.delete(orb);
    return 0;
  }
  charges.delete(orb);
  if ('charge' in orb) orb.charge = 0; // revert the rendered state too
  return amount;
}

/** Match reset / play-again: no charged state survives a fresh match. */
export function clearCharges(charges) {
  if (charges) charges.clear();
}
