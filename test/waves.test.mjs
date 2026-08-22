// Wave system verification (server room + LocalRoom parity):
//   - wave 1 spawns waveEnemyCount(1) enemies out of the pool; extra slots dead
//   - clearing every enemy -> matchState 'intermission' (popup-gated)
//   - during intermission players are INVULNERABLE (no PvP/enemy damage)
//   - intermission never auto-advances; 'nextWave' click -> countdown -> next
//     wave with more, tankier enemies
//   - hit-stun freezes enemy AI (no chase, no contact damage)
//   - play-again resets to wave 1
// Run: node test/waves.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import { waveEnemyCount, waveEnemyHp } from '../src/shared/waves.js';
import { archetypeForSlot, SHOOTER_PREFERRED_RANGE } from '../src/shared/sim/archetypes.js';
import fs from 'node:fs';
import path from 'node:path';
import { flushAll, _dirForTests } from '../src/server/persistence.js';
import { LocalRoom } from '../src/LocalRoom.js';

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, timeoutMs = 10000, label = 'condition') => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await waitMs(30);
  }
  throw new Error('timeout waiting for ' + label);
};

SERVER.rateLimit.capacity = 10000;
const httpServer = http.createServer();
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app)
});
gameServer.define('game', GameRoom);
await gameServer.listen(0);
const port = httpServer.address().port;

const newRoom = async (name) => {
  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('game', { name }, WorldState);
  while (r.state?.matchState !== 'playing') await waitMs(30);
  return { c, r };
};
const roomOf = (r) => [...GameRoom.instances].find((x) => x.roomId === r.roomId);
const aliveCount = (state) => state.enemies.filter((e) => e.hp > 0).length;
// Kill-drop XP (PRD-orb-drops.md) makes wave clears cross level thresholds
// more often -> level-up cards open the D7 pause wall and freeze the next
// countdown until picked. The wall is GLOBAL across players and every client
// must pick its OWN card (onChooseUpgrade binds to the sender's session), so
// drain everyone present.
const drainUpgradeCards = async (sr, ...clients) => {
  for (let i = 0; i < 24; i++) {
    let picked = false;
    for (const c of clients) {
      const p = sr.state.players.get(c.sessionId);
      if (p && p.pendingChoices.length > 0) {
        c.send('chooseUpgrade', { choice: p.pendingChoices[0] });
        picked = true;
      }
    }
    if (!picked) break;
    await waitMs(80);
  }
};

// --- Wave 1 shape ------------------------------------------------------------
{
  const host = await newRoom('Waves');
  const sr = roomOf(host.r);
  assert.equal(sr.state.wave, 1, 'match starts at wave 1');
  assert.equal(aliveCount(sr.state), waveEnemyCount(1), 'wave 1 activates its count');
  assert.equal(sr.state.enemies.length, SERVER.enemy.pool, 'pool holds every slot');
  assert.ok(sr.state.enemies.slice(waveEnemyCount(1)).every((e) => e.hp === 0),
    'unused pool slots are dead');
  host.r.leave();
}

// --- Clearing the wave -> intermission (gated on click) ----------------------
{
  const host = await newRoom('Clearer');
  const sr = roomOf(host.r);
  const me = sr.state.players.get(host.r.sessionId);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;

  // Cluster every wave-1 enemy in the frontal arc at 1 HP: one swing kills all.
  const alive = sr.state.enemies.filter((e) => e.hp > 0);
  alive.forEach((e, i) => {
    e.hp = 1;
    const ang = (i - (alive.length - 1) / 2) * 0.3; // small fan ahead (+X)
    e.x = 1.8 * Math.cos(ang);
    e.z = 1.8 * Math.sin(ang);
  });
  const scoreBefore = me.score;
  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitFor(() => sr.state.matchState === 'intermission', 2000, 'intermission after full clear');
  assert.ok(sr.state.enemies.every((e) => e.hp <= 0), 'every enemy dead');
  assert.equal(sr.state.wave, 1, 'wave number unchanged during intermission');
  assert.equal(me.score - scoreBefore, alive.length * SERVER.enemy.killScore,
    'each kill awarded killScore');

  // INVULNERABLE during intermission: a PvP swing cannot even start (input
  // gate), so the victim's HP cannot move.
  const c2 = new Client(`ws://localhost:${port}`);
  const r2 = await c2.joinById(host.r.roomId, { name: 'Rival' }, WorldState);
  await waitMs(200);
  const B = sr.state.players.get(r2.sessionId);
  B.x = 1.5; B.z = 0;
  const hpBefore = B.hp;
  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitMs(600);
  assert.equal(B.hp, hpBefore, 'intermission: players are invulnerable');
  assert.notEqual(sr.state.matchState, 'playing', 'intermission does not auto-advance');

  // nextWave click -> countdown -> playing with a bigger wave.
  await drainUpgradeCards(sr, host.r, r2); // ANY player's card walls the sim
  host.r.send('nextWave');
  await waitFor(() => sr.state.matchState === 'countdown', 1000, 'countdown after nextWave');
  await waitFor(() => sr.state.matchState === 'playing', 5000, 'playing after wave countdown');
  assert.equal(sr.state.wave, 2, 'wave counter advanced');
  assert.equal(aliveCount(sr.state), waveEnemyCount(2), 'wave 2 activates more slots');
  assert.ok(sr.state.enemies.slice(0, waveEnemyCount(2)).every((e) => e.hp === waveEnemyHp(2)),
    'wave-2 enemies spawn at wave-2 HP');

  r2.leave();
  host.r.leave();
}

// --- HIT-STUN: a struck enemy stops acting ------------------------------------
{
  const host = await newRoom('Stun');
  const sr = roomOf(host.r);
  const me = sr.state.players.get(host.r.sessionId);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
  sr.state.enemies.forEach((e, i) => { if (i > 0) { e.x = 26; e.z = 26; } });
  const enemy = sr.state.enemies[0];
  enemy.x = 2.2; enemy.z = 0; enemy.hp = waveEnemyHp(99); // tanky: survives the hit
  const hpBefore = enemy.hp;

  host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitFor(() => enemy.hp < hpBefore, 1500, 'strike landed');
  const xAtHit = enemy.x;
  const hpAtHit = me.hp;
  // The player runs far away — a STUNNED enemy must not chase (and cannot
  // reach contact) until the stun expires.
  me.x = -20; me.z = -20;
  await waitMs(300);
  assert.ok(Math.abs(enemy.x - xAtHit) < 0.05, 'stunned enemy does not chase');
  assert.equal(me.hp, hpAtHit, 'stunned enemy deals no contact damage');
  assert.equal(enemy.anim, 'hit', 'stunned enemy plays the hit react');
  // After the stun it resumes the chase (converging on the new position).
  // Budget 10s: full-suite runs share the event loop with peer sessions and
  // starve ticks below the old 5s (P1.4-class flake).
  await waitFor(() => Math.hypot(enemy.x - me.x, enemy.z - me.z) < 10, 10000, 'chase resumed after stun');
  host.r.leave();
}

// --- Play again resets to wave 1 ----------------------------------------------
{
  const host = await newRoom('Again');
  const sr = roomOf(host.r);
  host.r.send('nextWave'); // rejected: not intermission
  assert.equal(sr.state.wave, 1, 'nextWave rejected outside intermission');
  const me = sr.state.players.get(host.r.sessionId);
  me.score = SERVER.match.targetScore; // force the win
  await waitFor(() => sr.state.matchState === 'gameover', 3000, 'gameover after target score');
  host.r.send('playAgain');
  await waitFor(() => sr.state.matchState === 'playing', 6000, 'playing after play again');
  assert.equal(sr.state.wave, 1, 'play again resets to wave 1');
  assert.equal(aliveCount(sr.state), waveEnemyCount(1), 'wave 1 reactivated');
  host.r.leave();
}


// --- Enemy archetypes (PRD-enemy-archetypes.md): deterministic per-wave tags -
{
  const host = await newRoom('Archetype');
  const sr = roomOf(host.r);
  try {
  const me = sr.state.players.get(host.r.sessionId);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;

  // AC2: waves below ARCHETYPE_FROM_WAVE stay pure chasers.
  assert.ok(sr.state.enemies.every((e) => e.archetype === ''),
    'wave 1 carries zero archetype tags (onboarding unchanged)');

  // Kills grant XP -> level-up cards open the D7 PAUSE WALL on the next
  // tick (the gate scans BEFORE the wave-clear dispatch), freezing the sim
  // mid-clear. So pick cards WHILE racing toward intermission — a
  // post-intermission drain can never run.
  const clearWave = async () => {
    const alive = sr.state.enemies.filter((e) => e.hp > 0);
    alive.forEach((e, i) => {
      e.hp = 1;
      const ang = (i - (alive.length - 1) / 2) * 0.3;
      e.x = 1.8 * Math.cos(ang);
      e.z = 1.8 * Math.sin(ang);
    });
    host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
    let picked = 0;
    for (let i = 0; i < 400; i++) {
      if (me.pendingChoices.length > 0) {
        host.r.send('chooseUpgrade', { choice: me.pendingChoices[0] });
        picked++;
        await waitMs(60);
        continue;
      }
      if (sr.state.matchState === 'intermission' && picked > 0) break;
      if (sr.state.matchState === 'intermission') break; // no level crossed
      await waitMs(30);
    }
    assert.equal(sr.state.matchState, 'intermission',
      'intermission after archetype-test clear');
    assert.equal(me.pendingChoices.length, 0,
      'all level-up cards picked (pause wall released)');
  };

  await clearWave();
  host.r.send('nextWave');
  await waitFor(() => sr.state.matchState === 'playing', 8000, 'wave 2 playing');
  assert.ok(sr.state.enemies.filter((e) => e.hp > 0).every((e) => e.archetype === ''),
    'wave 2 still pure chasers');

  await clearWave();
  host.r.send('nextWave');
  await waitFor(() => sr.state.matchState === 'playing', 8000, 'wave 3 playing');

  // AC1: wave 3 mixes archetypes with EXACTLY ceil(baseHp * hpMul).
  const baseHp = waveEnemyHp(3);
  const live3 = sr.state.enemies.filter((e) => e.hp > 0);
  assert.equal(live3.length, waveEnemyCount(3), 'wave 3 count');
  for (const e of live3) {
    const slot = sr.state.enemies.indexOf(e);
    assert.equal(e.archetype, archetypeForSlot(3, slot),
      `slot ${slot} tag matches the shared selector`);
    const mul = e.archetype === 'Rusher' ? 0.75
      : e.archetype === 'Tank' ? 2 : 1;
    assert.equal(e.hp, Math.ceil(baseHp * mul),
      `hp composed exactly for ${e.archetype || 'chaser'} (slot ${slot})`);
  }
  const tags3 = live3.map((e) => e.archetype);
  assert.ok(tags3.includes('Rusher'), 'wave 3 contains a Rusher');
  assert.ok(tags3.includes('Tank'), 'wave 3 contains a Tank');
  } finally {
    host.r.leave(); // failure-safe: never wedge the event loop open
  }
}

// --- Kill-drop XP orbs (PRD-orb-drops.md) ------------------------------------
{
  const host = await newRoom('OrbDrops');
  const sr = roomOf(host.r);
  try {
    const me = sr.state.players.get(host.r.sessionId);
    me.x = 0; me.z = 0; me.rotY = Math.PI / 2;

    const alive = sr.state.enemies.filter((e) => e.hp > 0);
    alive.forEach((e, i) => {
      e.hp = 1;
      const ang = (i - (alive.length - 1) / 2) * 0.3;
      e.x = 1.8 * Math.cos(ang);
      e.z = 1.8 * Math.sin(ang);
    });
    host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
    await waitFor(() => sr.state.matchState === 'intermission', 3000,
      'intermission after orb-drop clear');

    // AC1: every credited kill charged a distinct orb; wave-1 crosses no
    // level threshold so there are exactly `alive.length` charges.
    assert.equal(sr.orbCharges.size, alive.length,
      'each kill charged one orb');
    for (const amount of sr.orbCharges.values()) {
      assert.equal(amount, SERVER.progression?.xpPerKill ?? 30,
        'plain kills charge xpPerKill');
    }
    // Charged orbs sit on corpse positions (post-knockback).
    const corpseSpots = new Set(sr.state.enemies.filter((e) => e.hp <= 0)
      .map((e) => `${e.x.toFixed(4)},${e.z.toFixed(4)}`));
    for (const orb of sr.orbCharges.keys()) {
      assert.ok(corpseSpots.has(`${orb.x.toFixed(4)},${orb.z.toFixed(4)}`),
        'charged orb teleported to its corpse');
    }

    // Collection drains charges and pays them beyond the base payout.
    // Standing on one corpse-fan spot may collect SEVERAL orbs in one tick —
    // account per-orb: every drained orb pays base score + its stored XP.
    const beforeSize = sr.orbCharges.size;
    let chargeSum = 0;
    for (const v of sr.orbCharges.values()) chargeSum += v;
    const target = [...sr.orbCharges.keys()][0];
    const xpBefore = me.xp;
    const scoreBefore = me.score;
    me.x = target.x;
    me.z = target.z;
    await waitFor(() => sr.orbCharges.size < beforeSize, 3000,
      'charged orb collected');
    await waitMs(150); // let same-tick neighbor pickups resolve too
    const collected = beforeSize - sr.orbCharges.size;
    assert.ok(collected >= 1, 'at least the targeted orb drained');
    assert.equal(me.score - scoreBefore, collected * SERVER.orb.score,
      'each drained orb paid base score exactly once');
    assert.equal(me.xp - xpBefore,
      collected * (SERVER.progression?.xpPerOrb ?? 20) + chargeSum - remainderChargeSum(sr),
      'XP = base per orb + all drained charges');
      function remainderChargeSum(sr2) {
        let sum = 0;
        for (const v of sr2.orbCharges.values()) sum += v;
        return sum;
      }
  } finally {
    host.r.leave();
  }
}


// --- Shooter archetype (PRD-enemy-archetypes.md, Shooter cycle) --------------
{
  const host = await newRoom('Shooters');
  const sr = roomOf(host.r);
  try {
    // Direct-drive like elitesIntegration: spawn wave 5 without grinding.
    sr.spawnWave(5);
    const shooters = [...sr.state.enemies].filter((e) => e.archetype === 'Shooter');
    assert.ok(shooters.length >= 1, 'wave 5 fields at least one Shooter');

    // Live fire: park the host inside band range of the first shooter.
    const me = sr.state.players.get(host.r.sessionId);
    const sh = shooters.find((e) => e.hp > 0);
    me.x = sh.x + SHOOTER_PREFERRED_RANGE;
    me.z = sh.z;
    const before = sr.state.projectiles.length;
    await waitFor(
      () => [...sr.state.projectiles].some((pr) => !pr.ownerIsPlayer),
      6000, 'shooter fired an enemy-owned arrow');
    const shot = [...sr.state.projectiles].find((pr) => !pr.ownerIsPlayer);
    assert.equal(shot.damage, SERVER.enemy.shotDamage, 'shot carries shotDamage');
    assert.equal(shot.kind, 'arrow', 'client renders it via generic arrow config');
    assert.ok(sr.state.projectiles.length >= before, 'pooled into state.projectiles');
  } finally {
    host.r.leave();
  }
}


// --- Magnet power-up (PRD-magnet.md) ------------------------------------------
{
  const host = await newRoom('Magnet');
  const sr = roomOf(host.r);
  try {
    const me = sr.state.players.get(host.r.sessionId);
    // All four types spawn now.
    assert.deepEqual([...new Set(sr.state.powerUps.map((pu) => pu.type))].sort(),
      ['double', 'magnet', 'shield', 'speed'], 'all four power-up types in play');

    // Direct-drive: grant the effect, park an orb 5u away, tick pickups.
    me.effects.set('magnet', SERVER.powerUps.magnet.durationMs);
    const orb = sr.state.orbs[0];
    orb.x = me.x + 5;
    orb.z = me.z;
    const xpBefore = me.xp;
    let ticks = 0;
    while (me.xp === xpBefore && ticks++ < 200) sr.updatePickups(0.1);
    assert.ok(me.xp > xpBefore, `orb converged and paid XP within budget (${ticks} ticks)`);
    // AC2: beyond-radius orbs never moved — verify with a far orb snapshot.
    const far = sr.state.orbs[1];
    far.x = 500; far.z = 500;
    sr.updatePickups(0.1);
    assert.equal(far.x, 500, 'out-of-radius orb unaffected');
    // AC4: expiry stops pulls.
    me.effects.delete('magnet');
    far.x = me.x + 5; far.z = me.z;
    sr.updatePickups(0.5);
    assert.equal(far.x, me.x + 5, 'no pull after effect expiry');
  } finally {
    host.r.leave();
  }
}


// --- Wave finale (PRD-wave-finale.md) -----------------------------------------
{
  const prevFinale = SERVER.wave.finaleWave;
  SERVER.wave.finaleWave = 2; // shrink the run for test speed
  try { try { fs.unlinkSync(path.join(_dirForTests(), 'Finale.json')); } catch {}
    const host = await newRoom('Finale');
    const sr = roomOf(host.r);
    try {
      const me = sr.state.players.get(host.r.sessionId);
      me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
      const clearWave = async () => {
        const alive = sr.state.enemies.filter((e) => e.hp > 0);
        alive.forEach((e, i) => {
          e.hp = 1;
          const ang = (i - (alive.length - 1) / 2) * 0.3;
          e.x = 1.8 * Math.cos(ang);
          e.z = 1.8 * Math.sin(ang);
          // Freeze pursuit during the setup->impact window: a Rusher closing
          // at 1.4x can cross BEHIND the swing arc on a loaded event loop,
          // making the fan miss (P1.4-class timing flake).
          sr.enemyStunUntil.set(e, Date.now() + 5000);
        });
        host.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
        await waitFor(() => sr.state.matchState === 'intermission', 3000, 'finale clear');
        await drainUpgradeCards(sr, host.r);
      };
      await clearWave();
      host.r.send('nextWave');
      await waitFor(() => sr.state.matchState === 'playing', 8000, 'finale wave 2 playing');
      await clearWave();
      // Advancing past the finale wave ends the match as a co-op VICTORY.
      host.r.send('nextWave');
      await waitFor(() => sr.state.matchState === 'gameover', 3000, 'victory gameover');
      assert.equal(sr.state.victory, true, 'AC1: victory flag set');
      // AC3: playAgain restores a fresh endless=false run.
      // AC1: the ending was recorded into per-player persistence.
      flushAll();
      const pf = path.join(_dirForTests(), 'Finale.json');
      const saved = JSON.parse(fs.readFileSync(pf, 'utf8'));
      assert.equal(saved.career.runs, 1);
      assert.equal(saved.career.victories, 1);
      assert.equal(saved.career.bestWave, 2);
      try { fs.unlinkSync(pf); } catch {}
      host.r.send('playAgain');
      await waitFor(() => sr.state.matchState === 'playing', 8000, 'playing after victory replay');
      assert.equal(sr.state.victory, false, 'victory reset on replay');
    } finally {
      host.r.leave();
    }
  } finally {
    SERVER.wave.finaleWave = prevFinale;
  }
}


// --- Finale Boss: Warlord on the finale wave ----------------------------------
{
  const prevFinale = SERVER.wave.finaleWave;
  SERVER.wave.finaleWave = 6; // NOT a multiple of 5: proves independence from elite cadence
  try {
    const host = await newRoom('Boss');
    const sr = roomOf(host.r);
    try {
      sr.spawnWave(6);
      const slot0 = sr.state.enemies[0];
      assert.equal(slot0.elite, 'Warlord', 'finale wave fields the boss');
      assert.equal(slot0.hp, Math.ceil(waveEnemyHp(6) * 3), 'boss hp composed');
      // Non-finale waves keep normal rolls (wave 7 has no special).
      sr.spawnWave(7);
      assert.equal(sr.state.enemies[0].elite, '', 'wave after finale is clean');
      host.r.leave();
    } finally {
      SERVER.wave.finaleWave = prevFinale;
    }
  } finally {
    // newRoom already left; outer finally kept for symmetry
  }
}

await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();

// ============================================================================
// LocalRoom parity: the offline solo sim runs the same wave flow
// ============================================================================
{
  const room = new LocalRoom();
  await room.join('Solo', 0);
  room._running = false;
  room._countdownTimer = 0;
  room._step(0.05);
  assert.equal(room.state.matchState, 'playing', 'LOCAL: playing after countdown');
  assert.equal(room.state.wave, 1, 'LOCAL: starts at wave 1');
  assert.equal(room.state.enemies.filter((e) => e.hp > 0).length, waveEnemyCount(1),
    'LOCAL: wave 1 count');

  // Kill the whole wave with one impact-aligned swing (1 HP fan ahead).
  const me = room.state.players.get(room.sessionId);
  me.x = 0; me.z = 0; me.rotY = Math.PI / 2;
  const alive = room.state.enemies.filter((e) => e.hp > 0);
  alive.forEach((e, i) => {
    e.hp = 1;
    const ang = (i - (alive.length - 1) / 2) * 0.3;
    e.x = 1.8 * Math.cos(ang);
    e.z = 1.8 * Math.sin(ang);
  });
  room.send('input', { dirX: 0, dirZ: 0, attack: true, skill: false, anim: 'attack', block: false });
  room._step(0.05); // process the attack input → schedule the pending melee strike
  await waitMs(SERVER.player.attackImpactMs + 250);
  room._step(0.05); // resolve the strike → kills all enemies → wave clear
  assert.equal(room.state.matchState, 'intermission', 'LOCAL: intermission after full clear');
  assert.ok(room.state.enemies.every((e) => e.hp <= 0), 'LOCAL: all dead');

  // Intermission invulnerability is enforced in the local sim too.
  me.hp = 50;
  assert.equal(room._damagePlayer(me, 10, null), false, 'LOCAL: damage rejected during intermission');
  assert.equal(me.hp, 50, 'LOCAL: hp untouched during intermission');

  // The popup gates the next wave; wave 2 is bigger.
  room.send('nextWave');
  assert.equal(room.state.matchState, 'countdown', 'LOCAL: nextWave starts countdown');
  room._countdownTimer = 0;
  room._step(0.05);
  assert.equal(room.state.matchState, 'playing', 'LOCAL: playing after wave countdown');
  assert.equal(room.state.wave, 2, 'LOCAL: wave 2');
  const alive2 = room.state.enemies.filter((e) => e.hp > 0);
  assert.equal(alive2.length, waveEnemyCount(2), 'LOCAL: wave 2 count');
  assert.ok(alive2.every((e) => e.hp === waveEnemyHp(2)), 'LOCAL: wave-2 HP');
  assert.ok(alive2.every((e) => e.hp === waveEnemyHp(2)), 'LOCAL: wave-2 HP');

  // Wave 3 archetypes: LOCAL parity with GameRoom by construction — both
  // rooms call the SAME markArchetypes, so tags + composed hp must equal
  // the pure selector's prediction exactly.
  const lme = room.state.players.get(room.sessionId);

  // Clear wave 2 (same one-swing idiom as the wave-1 clear above).
  const aliveW2 = room.state.enemies.filter((e) => e.hp > 0);
  aliveW2.forEach((e, i) => {
    e.hp = 1;
    const ang = (i - (aliveW2.length - 1) / 2) * 0.3;
    e.x = 1.8 * Math.cos(ang);
    e.z = 1.8 * Math.sin(ang);
  });
  lme.rotY = Math.PI / 2;
  // LocalRoom burns attackCd on SIM time (_step dt), not wall time — the
  // wave-1 clear's cooldown is still live here, so clear it like phase4
  // tests poke schema state directly.
  lme.attackCd = 0;
  room.send('input', { dirX: 0, dirZ: 0, attack: true, skill: false, anim: 'attack', block: false });
  room._step(0.05);
  await waitMs(SERVER.player.attackImpactMs + 250);
  room._step(0.05);
  assert.equal(room.state.matchState, 'intermission', 'LOCAL: intermission after wave-2 clear');

  // Drain level-up cards: the D7 gate scans BEFORE the wave-clear dispatch,
  // so cards born from the killing blows wall the NEXT manual step — pick,
  // step, repeat until the intermission lands.
  for (let i = 0; i < 12 && (lme.pendingChoices.length > 0 ||
       room.state.matchState !== 'intermission'); i++) {
    while (lme.pendingChoices.length > 0) {
      room.send('chooseUpgrade', { choice: lme.pendingChoices[0] });
      room._step(0.05);
    }
    room._step(0.05);
  }
  assert.equal(room.state.matchState, 'intermission', 'LOCAL: intermission reached');
  assert.equal(lme.pendingChoices.length, 0, 'LOCAL: cards drained');

  // AC5 parity: credited kills left identical charge values to GameRoom's
  // rule — every plain kill charges xpPerKill at its corpse. NOTE: count
  // CREDITED kills (waves spawned 3+4, all cleared), not hp<=0 slots — the
  // fixed pool keeps never-alive slots at hp 0 without any kill.
  assert.equal(room._orbCharges.size,
    waveEnemyCount(1) + waveEnemyCount(2),
    'LOCAL: one charge per credited kill');
  for (const amount of room._orbCharges.values()) {
    assert.equal(amount, SERVER.progression?.xpPerKill ?? 30,
      'LOCAL: charge value matches the shared rule');
  }

  room.send('nextWave');
  assert.equal(room.state.matchState, 'countdown', 'LOCAL: countdown to wave 3');
  room._countdownTimer = 0;
  room._step(0.05);
  assert.equal(room.state.wave, 3, 'LOCAL: wave 3');
  const baseHp3 = waveEnemyHp(3);
  for (let i = 0; i < room.state.enemies.length; i++) {
    const e = room.state.enemies[i];
    if (e.hp <= 0) continue;
    assert.equal(e.archetype, archetypeForSlot(3, i),
      `LOCAL: slot ${i} tag matches the shared selector`);
    const mul = e.archetype === 'Rusher' ? 0.75
      : e.archetype === 'Tank' ? 2 : 1;
    assert.equal(e.hp, Math.ceil(baseHp3 * mul),
      `LOCAL: hp composed identically (${e.archetype || 'chaser'}, slot ${i})`);
  }

  room.leave();
}

// --- LOCAL parity: wave-5 shooter tag + live volley --------------------------
{
  const lroom = new LocalRoom();
  await lroom.join('SoloShooter', 0);
  lroom._running = false;
  lroom._countdownTimer = 0;
  lroom._step(0.05);
  lroom._spawnWave(5);
  assert.ok([...lroom.state.enemies].some((e) => e.archetype === 'Shooter'),
    'LOCAL: wave-5 shooter tag matches the shared selector');
  const lme = lroom.state.players.get(lroom.sessionId);
  const lsh = [...lroom.state.enemies].find((e) => e.archetype === 'Shooter' && e.hp > 0);
  lme.x = lsh.x + SHOOTER_PREFERRED_RANGE;
  lme.z = lsh.z;
  let steps = 0;
  while (![...lroom.state.projectiles].some((pr2) => !pr2.ownerIsPlayer) &&
         steps++ < 60) {
    await waitMs(80);
    lroom._step(0.05);
  }
  assert.ok(steps <= 60, 'LOCAL: shooter fired within budget');
  const lshot = [...lroom.state.projectiles].find((pr2) => !pr2.ownerIsPlayer);
  assert.equal(lshot.damage, SERVER.enemy.shotDamage, 'LOCAL: same shotDamage');
  lroom.leave();
}

// --- LOCAL parity: finale ends with victory + replay reset --------------------
{
  const prevFinale = SERVER.wave.finaleWave;
  SERVER.wave.finaleWave = 1;
  try {
    const lroom = new LocalRoom();
    await lroom.join('SoloFinale', 0);
    lroom._running = false;
    lroom._countdownTimer = 0;
    lroom._step(0.05);
    const lme = lroom.state.players.get(lroom.sessionId);
    lme.x = 0; lme.z = 0;
    // Clear wave 1 (the finale here).
    const la = [...lroom.state.enemies].filter((e) => e.hp > 0);
    la.forEach((e, i) => { e.hp = 1; const a2 = (i - (la.length - 1) / 2) * 0.3; e.x = 1.8 * Math.cos(a2); e.z = 1.8 * Math.sin(a2); });
    lme.rotY = Math.PI / 2;
    lroom.send('input', { dirX: 0, dirZ: 0, attack: true, skill: false, anim: 'attack', block: false });
    lroom._step(0.05);
    await waitMs(SERVER.player.attackImpactMs + 250);
    lroom._step(0.05);
    for (let i = 0; i < 12 && (lme.pendingChoices.length > 0 ||
         lroom.state.matchState !== 'intermission'); i++) {
      while (lme.pendingChoices.length > 0) {
        lroom.send('chooseUpgrade', { choice: lme.pendingChoices[0] });
        lroom._step(0.05);
      }
      lroom._step(0.05);
    }
    assert.equal(lroom.state.matchState, 'intermission', 'LOCAL finale: cleared');
    // Advancing past finale -> victory gameover.
    lroom.send('nextWave');
    lroom._step(0.05);
    assert.equal(lroom.state.matchState, 'gameover', 'LOCAL: victory gameover');
    assert.equal(lroom.state.victory, true, 'LOCAL AC1: victory flag');
    lroom.leave();
  } finally {
    SERVER.wave.finaleWave = prevFinale;
  }
}

// --- LOCAL parity: finale boss -------------------------------------------------
{
  const prevFinale = SERVER.wave.finaleWave;
  SERVER.wave.finaleWave = 6;
  try {
    const lroom2 = new LocalRoom();
    await lroom2.join('SoloBoss', 0);
    lroom2._running = false;
    lroom2._countdownTimer = 0;
    lroom2._step(0.05);
    lroom2._spawnWave(6);
    assert.equal(lroom2.state.enemies[0].elite, 'Warlord', 'LOCAL: boss parity');
    assert.equal(lroom2.state.enemies[0].hp,
      Math.ceil(waveEnemyHp(6) * 3), 'LOCAL: boss hp parity');
    lroom2.leave();
  } finally {
    SERVER.wave.finaleWave = prevFinale;
  }
}

console.log('ok — waves.test.mjs: wave spawning/scaling, intermission gate + invulnerability, nextWave click flow, hit-stun freeze, play-again reset, local-sim parity, enemy archetypes');
process.exit(0);
