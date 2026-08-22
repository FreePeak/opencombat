// D7 pause wall + D8 match reset — shared by BOTH game sims (GameRoom +
// LocalRoom). Extracted from two mirrored room implementations (P1.3 Slice 4,
// see docs/plans/p1.3-shared-sim-extraction.md sections 1 D7/D8); phase
// DISPATCH around the wall and the end-of-reset transition stay in the rooms.
//
// Every function takes a ctx built ONCE per room:
//   state:          WorldState (.paused/.matchState/.intermissionUntil written
//                   by the gate; winner/projectiles/orbs/powerUps/players by
//                   the reset)
//   players:        Map-like sid -> PlayerState (pending-card scan)
//   pendingUntil:   Map sid -> ms auto-pick deadline (reset clears per sid)
//   pendingQueue:   Map sid -> queued level numbers (reset clears per sid)
//   pauseBox:       { until } ms epoch the wall cap expires at — mutable ref
//                   holder the gate arms/disarms (0 = no wall)
//   intermissionBox:{ until } ms epoch mirror of the live intermission
//                   deadline — extended while walled so the breather clock
//                   cannot run out behind a paused sim
//   now():          injected clock anchoring/reading the wall — never
//                 defaulted, Date.now and performance.now must not mix in one
//                 ctx
//   checkAutoPicks(): fired FIRST on every tick so auto-pick deadlines expire
//                 during a pause (pausing must never stall the pick)
//   checkWinWhilePaused(): per-side win evaluation at dt=0, invoked only on
//                 WALLED ticks: GameRoom runs its full checkWinConditions(0)
//                 (score AND timed path); LocalRoom keeps its historical
//                 score-target-only block. Untested edge kept per-side rather
//                 than reconciled (design doc section 1, D7 difference 2).
//   spawnWave(n):   reset hook reactivating wave 1 over the fixed pool
//
// Schema objects are consumed duck-typed; construction of PlayerState/Orb/
// PowerUp instances stays in the rooms. No three / colyseus imports here —
// pinned by test/simMatchPhases.test.mjs.

import { SERVER } from '../../server/config.js';
import { classStats } from '../skills.js';

/** Default global-wall cap when SERVER.wave does not configure one. */
const FALLBACK_MAX_PAUSE_MS = 30000;

/**
 * Auto-pick stalled cards, compute the global pause wall (any player holding
 * pending upgrade choices), cap it by maxPauseMs and extend an active
 * intermission deadline while walled. Ordering contract: checkAutoPicks runs
 * BEFORE the scan, so a deadline expiring exactly now resolves its card and
 * never opens the wall for nothing.
 *
 * Once the cap expires the wall STAYS released while picks remain open (the
 * armed timestamp is not refreshed; it disarms only on a free tick) — both
 * rooms shipped this exact behavior before extraction and tests pin it.
 *
 * @param {object} ctx - room context (see module header)
 * @param {number} dt - tick length in SECONDS
 * @returns {{dtEff: number, paused: boolean, walled: boolean}} — dtEff 0
 *   means skip the world step this tick (checkWinWhilePaused already ran);
 *   `paused` is the raw pending-scan result (LocalRoom consults it later in
 *   its step to hold the intermission auto-advance).
 */
export function pauseGate(ctx, dt) {
  const state = ctx.state;

  // Phase 4: auto-pick stalled upgrade cards — must run before pause wall so
  // the deadline actually fires (pausing the sim must NOT stall the pick).
  ctx.checkAutoPicks?.();

  let paused = false;
  for (const player of ctx.players.values()) {
    if (player.pendingChoices.length > 0) { paused = true; break; }
  }
  state.paused = paused;

  let dtEff = dt;
  let walled = false;
  if (paused) {
    const now = ctx.now();
    if (!ctx.pauseBox.until) {
      ctx.pauseBox.until = now +
        (ctx.maxPauseMs ?? SERVER.wave?.maxPauseMs ?? FALLBACK_MAX_PAUSE_MS);
    }
    if (now >= ctx.pauseBox.until) {
      state.paused = false; // cap expired: world resumes, picks stay open
    } else {
      if (state.matchState === 'intermission' && ctx.intermissionBox.until) {
        ctx.intermissionBox.until += dt * 1000;
        state.intermissionUntil = ctx.intermissionBox.until;
      }
      walled = true;
      dtEff = 0;
    }
  } else {
    ctx.pauseBox.until = 0;
  }

  // Paused: still evaluate win conditions so progression doesn't deadlock
  // behind a pending upgrade card (per-side hook — see module header).
  if (walled) ctx.checkWinWhilePaused?.();

  return { dtEff, paused, walled };
}

/**
 * Reset players/orbs/enemies-via-spawnWave/powerups/winner/scratch for a
 * fresh match. The caller keeps its gates (play-again only after gameover,
 * join-during-gameover bypasses) and the end-of-reset transition
 * (startCountdown vs inline countdown fields + notify).
 *
 * Sanctioned alignment #2 (design doc section 1, D8): BOTH rooms clear live
 * projectiles on reset — GameRoom gains the clear LocalRoom always had;
 * stale server projectiles would otherwise resume flying mid-new-match.
 *
 * @param {object} ctx - room context (see module header)
 * @param {object} opts {
 *   samplePos(kind, entity): position sampler — kind is 'player' | 'orb' |
 *     'powerup'. May return {x,z} or {x,z,rotY}; rotY is applied only when
 *     provided (GameRoom's square sampler preserves facing, LocalRoom's
 *     origin sampler zeroes it — pre-extraction behavior on both sides).
 *   resetProjectiles: clear state.projectiles (default true — alignment #2)
 *   onResetPlayerScratch(sid): room-owned per-seat scratch (input buffers,
 *     cooldown/invuln maps) cleared here
 *   onResetTransient(): room melee-impact buffers dropped right before the
 *     wave spawns
 *   onResetPowerUps(): power-up respawn bookkeeping (GameRoom's tick-driven
 *     powerUpTimers map; LocalRoom's setTimeout flow needs nothing)
 * }
 */
export function resetMatchState(ctx, opts = {}) {
  const state = ctx.state;

  // Winner cleared first; LocalRoom's _matchEnded flag stays room-side.
  state.winnerId = '';
  state.winnerName = '';
  state.victory = false; // PRD-wave-finale.md: replays start un-won
  if (opts.resetProjectiles !== false) state.projectiles.clear(); // alignment #2

  // Players: repositioned by the injected sampler, base HP, everything that
  // accumulated during the match back to fresh.
  for (const player of state.players.values()) {
    const p = opts.samplePos('player', player);
    player.x = p.x;
    player.z = p.z;
    if (p.rotY !== undefined) player.rotY = p.rotY;
    player.hp = classStats(player.character).hp; // Phase 3: per-class base HP
    player.score = 0;
    player.anim = 'idle';
    player.blocking = false;
    player.attackCd = 0;
    player.skillCd = 0;
    player.effects.clear(); // buffs never carry into the next match
    // Phase 4: fresh match = back to level 1, no cards
    player.level = 1;
    player.xp = 0;
    while (player.pendingChoices.length) player.pendingChoices.pop();
    player.upgrades.clear();
  }

  // Per-player scratch: auto-pick deadlines + queued reveals die with the
  // match; rooms extend with their transport-scoped maps via the hook.
  for (const sid of state.players.keys()) {
    ctx.pendingUntil.delete(sid);
    ctx.pendingQueue?.delete(sid);
    opts.onResetPlayerScratch?.(sid);
  }

  // Orbs repositioned.
  for (const orb of state.orbs) {
    const p = opts.samplePos('orb', orb);
    orb.x = p.x;
    orb.z = p.z;
  }

  // Fresh match = wave 1 (spawnWave clears every enemy stun/anim override);
  // transient melee buffers drop with it.
  opts.onResetTransient?.();
  ctx.spawnWave(1);

  // Power-ups repositioned and back in play; respawn bookkeeping stays with
  // the mechanism that owns it (hook above).
  for (const pu of state.powerUps) {
    const p = opts.samplePos('powerup', pu);
    pu.x = p.x;
    pu.z = p.z;
    pu.active = true;
  }
  opts.onResetPowerUps?.();
}
