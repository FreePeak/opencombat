// D2 progression bookkeeping — XP grant -> level-up -> card roll -> auto-pick
// -> manual pick — shared by BOTH game sims (GameRoom + LocalRoom). Extracted
// from two mirrored room implementations (P1.3 Slice 1, see
// docs/plans/p1.3-shared-sim-extraction.md); pure math lives in
// ../progression.js, this module only wires the room-level flow around it.
//
// Every function takes a ctx built ONCE per room:
//   players:      Map-like sid -> PlayerState (room-owned schema)
//   pendingUntil: Map sid -> ms auto-pick deadline (room-owned scratch)
//   pendingQueue: Map sid -> queued level numbers (room-owned scratch)
//   now():        injected clock — never defaulted, Date.now and
//                 performance.now must not mix inside one ctx
//   emit(sid, type, data): transport hook (client send / local fan-out)
//   log(event, fields) / warn(event, fields): observability hooks; LocalRoom
//                 passes no-ops so its observable behavior stays unchanged.
//
// Schema objects are consumed duck-typed exactly like progression.js already
// does; construction of PlayerState instances stays in the rooms. No three /
// colyseus imports here — pinned by test/simLeveling.test.mjs.

import { SERVER } from '../../server/config.js';
import {
  xpForLevel,
  rollUpgrades,
  getUpgrade,
  effectiveMaxHp,
  effectiveXp,
  AUTO_PICK_MS,
} from '../progression.js';

/** Configurable auto-pick window (tests shorten it via SERVER.progression). */
function autoPickMs() {
  return SERVER.progression?.autoPickMs ?? AUTO_PICK_MS;
}

/**
 * Deterministic per-(sid, level) seed: the same level-up for the same player
 * always rolls the same 3 cards, different players/levels differ. The `|| 1`
 * guard keeps makeRng(seed) stable if a hash ever collapses to 0 (unreachable
 * through the ':' separator today, kept for parity with the rooms).
 */
export function hashSeed(sid, level) {
  let h = 0;
  const s = sid + ':' + level;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h || 1;
}

/** Clear then fill `player.pendingChoices` with `picks` (ArraySchema idiom). */
function setChoices(player, picks) {
  while (player.pendingChoices.length) player.pendingChoices.pop();
  for (const id of picks) player.pendingChoices.push(id);
}

/** Roll the seeded cards for `level`, arm the deadline, log + emit. */
function revealCards(ctx, sid, player, level, event) {
  const seed = hashSeed(sid, level);
  const picks = rollUpgrades(seed, player.character, player.upgrades);
  setChoices(player, picks);
  ctx.pendingUntil.set(sid, ctx.now() + autoPickMs());
  ctx.log?.(event, { sid, level, choices: picks });
  ctx.emit?.(sid, 'levelUp', { level, choices: picks });
}

/** Queue storage for `sid`; entries are created lazily like GameRoom did. */
function queueFor(ctx, sid) {
  let queue = ctx.pendingQueue.get(sid);
  if (!queue) { queue = []; ctx.pendingQueue.set(sid, queue); }
  return queue;
}

/**
 * Apply the Scholar bonus to `baseXp`, bank it on the player, then maybe
 * level up. Silent for unknown sids or non-positive effective amounts.
 */
export function grantXp(ctx, sid, baseXp) {
  const player = ctx.players.get(sid);
  if (!player) return;
  const amt = effectiveXp(baseXp, player.upgrades);
  if (amt <= 0) return;
  player.xp += amt;
  ctx.log?.('xp_gain', { sid, amount: amt, total: player.xp });
  maybeLevelUp(ctx, sid);
}

/**
 * Level up while xp suffices. If a card is already showing or a queue exists,
 * later levels still increment (HUD updates immediately) but their cards are
 * queued until the current pick(s) resolve.
 */
export function maybeLevelUp(ctx, sid) {
  const player = ctx.players.get(sid);
  if (!player) return;
  const queue = queueFor(ctx, sid);
  while (player.xp >= xpForLevel(player.level + 1)) {
    const nextLevel = player.level + 1;
    if (player.pendingChoices.length > 0 || queue.length > 0) {
      player.level = nextLevel;
      queue.push(nextLevel);
      ctx.log?.('level_queued', { sid, level: player.level, queued: queue.length });
      continue;
    }
    player.level = nextLevel;
    revealCards(ctx, sid, player, player.level, 'level_up');
  }
}

/** Pop the next queued level-up (if any) and show its seeded cards. */
export function showNextQueued(ctx, sid) {
  const player = ctx.players.get(sid);
  if (!player) return;
  const queue = ctx.pendingQueue.get(sid);
  if (!queue || queue.length === 0) return;
  // The player's level already reflects this queued level (incremented at
  // queue time), so seeding for `lvl` is correct.
  const lvl = queue.shift();
  revealCards(ctx, sid, player, lvl, 'level_up_queued_show');
}

/**
 * Stack-guarded upgrade apply; vitality heals +30 instantly (clamped to the
 * upgraded max HP). @returns true when the stack was recorded.
 */
export function applyUpgrade(ctx, sid, upgradeId) {
  const player = ctx.players.get(sid);
  if (!player) return false;
  const def = getUpgrade(upgradeId);
  if (!def) return false;
  const cur = player.upgrades.get(upgradeId) || 0;
  if (cur >= (def.maxStacks ?? 99)) return false;
  player.upgrades.set(upgradeId, cur + 1);
  if (upgradeId === 'vitality') {
    const maxHp = effectiveMaxHp(player.character, player.upgrades);
    player.hp = Math.min(maxHp, player.hp + 30);
  }
  ctx.log?.('upgrade_pick', { sid, upgradeId, stacks: cur + 1, level: player.level });
  return true;
}

/**
 * Fire every expired auto-pick deadline (one pass over a snapshot so deletes
 * mid-loop are safe), apply the first offered card, and chain queued reveals
 * or fresh XP-based levels afterwards.
 */
export function checkAutoPicks(ctx) {
  const now = ctx.now();
  for (const [sid, deadline] of [...ctx.pendingUntil.entries()]) {
    if (now < deadline) continue;
    const player = ctx.players.get(sid);
    if (!player || player.pendingChoices.length === 0) {
      ctx.pendingUntil.delete(sid); // stale entry GC
      continue;
    }
    const auto = player.pendingChoices[0];
    ctx.log?.('upgrade_auto_pick', { sid, upgradeId: auto });
    setChoices(player, []);
    ctx.pendingUntil.delete(sid);
    applyUpgrade(ctx, sid, auto);
    ctx.emit?.(sid, 'upgradeResult', { picked: auto, auto: true });
    const queue = ctx.pendingQueue.get(sid);
    if (queue && queue.length > 0) showNextQueued(ctx, sid);
    else maybeLevelUp(ctx, sid);
  }
}

/**
 * Validate + apply a manual pick of one pending card.
 * @param {string} rawChoice — already extracted from the transport message by
 *   the caller (rooms keep their parsing quirks).
 * @returns {'ok'|'no_pending'|'not_offered'|'apply_failed'}
 */
export function chooseUpgrade(ctx, sid, rawChoice) {
  const player = ctx.players.get(sid);
  if (!player) return 'no_pending';
  if (player.pendingChoices.length === 0) {
    ctx.warn?.('upgrade_rejected', { sid, reason: 'no_pending' });
    return 'no_pending';
  }
  const choice = String(rawChoice ?? '');
  if (!player.pendingChoices.includes(choice)) {
    ctx.warn?.('upgrade_rejected', { sid, reason: 'not_offered', choice });
    return 'not_offered';
  }
  setChoices(player, []);
  ctx.pendingUntil.delete(sid);
  const ok = applyUpgrade(ctx, sid, choice);
  if (!ok) {
    ctx.warn?.('upgrade_rejected', { sid, reason: 'apply_failed', choice });
    return 'apply_failed';
  }
  ctx.emit?.(sid, 'upgradeResult', { picked: choice, auto: false });
  const queue = ctx.pendingQueue.get(sid);
  if (queue && queue.length > 0) showNextQueued(ctx, sid);
  else maybeLevelUp(ctx, sid);
  return 'ok';
}
