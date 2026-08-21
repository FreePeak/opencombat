// D3 intermission shop effects — shared by BOTH game sims (GameRoom +
// LocalRoom). Extracted from two mirrored room implementations (P1.3 Slice 2,
// see docs/plans/p1.3-shared-sim-extraction.md). The gate order and all three
// formulas are byte-identical between the rooms; what differed (per-sid Map
// vs boolean pick flag, warn/log hooks, transport) stays with the rooms via
// the ctx below.
//
// ctx built ONCE per room:
//   players:     Map-like sid -> PlayerState (room-owned schema)
//   state:       WorldState (.matchState gates, .wave feeds shop_pick logs)
//   shopChoices: Map sid -> choice applied this intermission (room-owned
//                scratch; GameRoom already used this shape, LocalRoom
//                migrated its boolean to it in Slice 2)
//   emit(sid, type, data): transport hook ('shopResult')
//   log(event, fields) / warn(event, fields): observability hooks; LocalRoom
//                passes neither so its observable behavior stays unchanged.
//
// No clock is injected — the shop has no timers. Schema objects are consumed
// duck-typed; no three / colyseus imports here — pinned by
// test/simCombatBook.test.mjs.

import { SERVER } from '../../server/config.js';
import { getUpgrade, effectiveMaxHp } from '../progression.js';

const VALID_CHOICES = ['heal', 'speed', 'vitality'];

/**
 * Gate (intermission + once-per-intermission + known choice) and apply one
 * breather pick. The pick is RECORDED before effects apply — a vitality pick
 * at maxStacks is consumed but grants nothing — exactly as both rooms did.
 *
 * @param {object} ctx - room context (see module header)
 * @param {string} sid
 * @param {*} rawChoice - already extracted from the transport message by the
 *   caller; coerced like the rooms did (`String(choice ?? '')`)
 * @returns {{ok: true, choice: string}
 *           | {ok: false, reason?: 'not_intermission'|'already_picked'|
 *                          'invalid_choice'}}
 *   A missing player returns {ok:false} with NO reason and warns nothing,
 *   matching GameRoom's silent early-return.
 */
export function applyShopChoice(ctx, sid, rawChoice) {
  const player = ctx.players.get(sid);
  if (!player) return { ok: false };
  if (ctx.state.matchState !== 'intermission') {
    ctx.warn?.('shop_rejected', { sid, reason: 'not_intermission' });
    return { ok: false, reason: 'not_intermission' };
  }
  if (ctx.shopChoices.has(sid)) {
    ctx.warn?.('shop_rejected', { sid, reason: 'already_picked' });
    return { ok: false, reason: 'already_picked' };
  }
  const choice = String(rawChoice ?? '');
  if (!VALID_CHOICES.includes(choice)) {
    ctx.warn?.('shop_rejected', { sid, reason: 'invalid_choice', choice });
    return { ok: false, reason: 'invalid_choice' };
  }
  ctx.shopChoices.set(sid, choice);
  if (choice === 'heal') {
    const maxHp = effectiveMaxHp(player.character, player.upgrades);
    player.hp = Math.min(maxHp, Math.max(player.hp, Math.floor(maxHp * 0.5) + 20));
  } else if (choice === 'speed') {
    // buff for next wave's early seconds
    player.effects.set('speed', SERVER.powerUps.speed.durationMs);
  } else if (choice === 'vitality') {
    // one-shot vitality-lite: +15 max HP via bonus (stored as upgrade for parity)
    const cur = player.upgrades.get('vitality') || 0;
    const def = getUpgrade('vitality');
    if (cur < (def.maxStacks ?? 99)) {
      player.upgrades.set('vitality', cur + 1);
      const maxHp = effectiveMaxHp(player.character, player.upgrades);
      player.hp = Math.min(maxHp, player.hp + 15);
    }
  }
  ctx.emit?.(sid, 'shopResult', { picked: choice });
  ctx.log?.('shop_pick', { sid, choice, wave: ctx.state.wave });
  return { ok: true, choice };
}
