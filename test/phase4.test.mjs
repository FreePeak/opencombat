// Phase 4 TDD: leveling + upgrade cards — integration (server + local sim).
// Tests that XP gain -> level up -> 3 choices -> manual pick / 10s auto-pick,
// upgrades affect stats, and resetMatch clears progression. Offline parity too.
// Run: node test/phase4.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import { xpForLevel, rollUpgrades, getUpgrade } from '../src/shared/progression.js';
import { classStats } from '../src/shared/skills.js';
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

// Raise join bucket for local suite
SERVER.rateLimit.capacity = 10000;
const prevAutoPick = SERVER.progression.autoPickMs;

// --- Boot ephemeral server -------------------------------------------------
const httpServer = http.createServer();
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app)
});
gameServer.define('game', GameRoom);
await gameServer.listen(0);
const port = httpServer.address().port;
const client = new Client(`ws://localhost:${port}`);

const roomOf = (r) => [...GameRoom.instances].find((x) => x.roomId === r.roomId);
const newRoom = async (name, character = 0) => {
  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('game', { name, character }, WorldState);
  await waitFor(() => r.state?.matchState === 'playing', 15000, `${name}: playing`);
  return { c, r };
};

// ---------------------------------------------------------------------------
// 1. XP curve + initial state
// ---------------------------------------------------------------------------
{
  const { r } = await newRoom('L1');
  const sr = roomOf(r);
  const p = sr.state.players.get(r.sessionId);
  const me = r.state.players.get(r.sessionId);
  assert.equal(p.level, 1, 'starts at level 1');
  assert.equal(p.xp, 0, 'starts at 0 xp');
  assert.equal(p.pendingChoices.length, 0, 'no pending at start');
  assert.equal(p.upgrades.size, 0, 'no upgrades at start');
  assert.equal(me.level, 1, 'client sees level 1');
  r.leave();
  await waitMs(200);
}

// ---------------------------------------------------------------------------
// 2. Orb XP -> level up -> 3 choices offered
// ---------------------------------------------------------------------------
{
  const { r } = await newRoom('L2');
  const sr = roomOf(r);
  const p = () => sr.state.players.get(r.sessionId);
  const me = () => r.state.players.get(r.sessionId);

  // give just enough XP to trigger level 2 (100)
  // via direct grantXp path — simulate orb/kill by calling sr.grantXp
  // (faster than steering to an orb).
  sr.grantXp(r.sessionId, 100);
  await waitFor(() => me().level === 2, 3000, 'level 2 after 100 xp');
  assert.equal(p().xp, 100, 'xp stored');
  assert.equal(p().pendingChoices.length, 3, '3 choices offered on level up');
  assert.equal(new Set([...p().pendingChoices]).size, 3, 'choices distinct');
  // client sees same pending
  await waitMs(100);
  assert.equal(me().pendingChoices.length, 3, 'client sees 3 pending');
  assert.deepEqual([...me().pendingChoices], [...p().pendingChoices], 'client pending matches server');

  // choices must match seeded rollUpgrades
  const expected = rollUpgrades(sr.hashSeed(r.sessionId, 2), p().character, new Map());
  assert.deepEqual([...p().pendingChoices], expected, 'choices equal seeded rollUpgrades');

  r.leave();
  await waitMs(200);
}

// ---------------------------------------------------------------------------
// 3. Manual pick clears pending and records upgrade; vitality heals
// ---------------------------------------------------------------------------
{
  const { r } = await newRoom('L3');
  const sr = roomOf(r);
  const p = () => sr.state.players.get(r.sessionId);
  // Ensure we level up with a pick that includes vitality if possible.
  // Force a level-up and then fake-choose vitality even if not offered?
  // Instead, roll until vitality appears — cheaper to directly set pending
  // to known picks that include vitality, then test pick path.
  sr.grantXp(r.sessionId, 100);
  await waitFor(() => p().pendingChoices.length === 3, 3000, 'pending before pick');
  // overwrite pending to include vitality so we can test its hp effect
  const player = p();
  while (player.pendingChoices.length) player.pendingChoices.pop();
  player.pendingChoices.push('vitality');
  player.pendingChoices.push('swift');
  player.pendingChoices.push('heavy_hand');
  // damage player so vitality heal is visible
  player.hp = 50;
  const hpBefore = player.hp;
  r.send('chooseUpgrade', { choice: 'vitality' });
  await waitFor(() => p().pendingChoices.length === 0, 3000, 'pending cleared after pick');
  assert.equal(p().upgrades.get('vitality'), 1, 'vitality stack recorded');
  assert.ok(p().hp > hpBefore, `vitality healed (hp ${hpBefore} -> ${p().hp})`);
  assert.equal(p().level, 2, 'level stays 2 after pick');

  // invalid pick rejected: set pending again and try unknown
  player.pendingChoices.push('swift');
  player.pendingChoices.push('heavy_hand');
  player.pendingChoices.push('quick_draw');
  sr.pendingUntil.set(r.sessionId, Date.now() + 60000); // keep alive
  r.send('chooseUpgrade', { choice: 'nonexistent' });
  await waitMs(300);
  assert.equal(p().pendingChoices.length, 3, 'invalid pick keeps pending');
  assert.equal(p().upgrades.get('nonexistent'), undefined, 'invalid upgrade not recorded');

  r.leave();
  await waitMs(200);
}

// ---------------------------------------------------------------------------
// 4. 10s auto-pick (tuned fast for test)
// ---------------------------------------------------------------------------
{
  SERVER.progression.autoPickMs = 600;
  const { r } = await newRoom('L4');
  const sr = roomOf(r);
  const p = () => sr.state.players.get(r.sessionId);
  sr.grantXp(r.sessionId, 100);
  await waitFor(() => p().pendingChoices.length === 3, 3000, 'pending before auto');
  const picks = [...p().pendingChoices];
  const auto = picks[0];
  // wait for auto-pick
  await waitFor(() => p().pendingChoices.length === 0, 3000, 'auto-pick clears pending');
  assert.equal(p().upgrades.get(auto), 1, `auto-picked ${auto} recorded`);
  assert.equal(p().level, 2, 'level stays after auto-pick');
  r.leave();
  await waitMs(200);
  SERVER.progression.autoPickMs = prevAutoPick;
}

// ---------------------------------------------------------------------------
// 5. Queued level-ups: burst of XP while picking is pending
// ---------------------------------------------------------------------------
{
  const { r } = await newRoom('L5');
  const sr = roomOf(r);
  const p = () => sr.state.players.get(r.sessionId);
  // Enough XP for 2 levels at once: 250 => level 3
  sr.grantXp(r.sessionId, 250);
  await waitFor(() => p().level === 3, 3000, 'level 3 after 250 xp');
  // Only first level's cards are showing; second is queued
  assert.equal(p().pendingChoices.length, 3, 'only first level cards pending');
  const firstPicks = [...p().pendingChoices];
  // Verify first picks match level 2 seed
  const expectL2 = rollUpgrades(sr.hashSeed(r.sessionId, 2), p().character, new Map());
  assert.deepEqual(firstPicks, expectL2, 'first picks match level 2 seed');
  r.send('chooseUpgrade', { choice: firstPicks[0] });
  await waitFor(() => p().pendingChoices.length === 3 && [...p().pendingChoices].join('|') !== firstPicks.join('|'), 3000, 'second level cards after first pick');
  // Now second level's cards should be a fresh rollout for level 3 (queued)
  const secondPicks = [...p().pendingChoices];
  assert.equal(secondPicks.length, 3, 'queued level gives 3 picks');
  assert.equal(new Set(secondPicks).size, 3, 'queued picks distinct');
  // picks must be valid upgrade ids
  for (const id of secondPicks) assert.ok(getUpgrade(id), `queued pick ${id} is valid upgrade`);
  // pick second
  r.send('chooseUpgrade', { choice: secondPicks[0] });
  await waitFor(() => p().pendingChoices.length === 0, 3000, 'second pick clears');
  assert.equal(p().upgrades.size, 2, 'two upgrades after two levels');
  r.leave();
  await waitMs(200);
}

// ---------------------------------------------------------------------------
// 6. XP from orb pickup and kill (server path)
// ---------------------------------------------------------------------------
{
  const { r } = await newRoom('L6');
  const sr = roomOf(r);
  const p = () => sr.state.players.get(r.sessionId);
  const beforeXp = p().xp;
  // Orb pickup via server's shared logic: place orb on player and tick pickups
  const orb = sr.state.orbs[0];
  orb.x = p().x;
  orb.z = p().z;
  sr.updatePickups(0.05);
  await waitMs(100);
  assert.ok(p().xp > beforeXp, `orb gave XP (${beforeXp} -> ${p().xp})`);
  const xpAfterOrb = p().xp;
  // Kill an enemy via hitEnemy path
  const enemy = sr.state.enemies.find((e) => e.hp > 0);
  const ehp = enemy.hp;
  sr.hitEnemy(enemy, ehp, p().x, p().z, p());
  await waitMs(100);
  assert.equal(enemy.hp, 0, 'kill succeeded');
  assert.ok(p().xp > xpAfterOrb, `kill gave XP (${xpAfterOrb} -> ${p().xp})`);

  // Scholar bonus: grant vitality's scholar? Actually scholar is separate.
  // Set scholar stack and verify next grant is boosted
  p().upgrades.set('scholar', 1);
  const beforeScholarXp = p().xp;
  sr.grantXp(r.sessionId, 20);
  const gained = p().xp - beforeScholarXp;
  assert.equal(gained, 24, 'scholar +20% => 20 -> 24');

  r.leave();
  await waitMs(200);
}

// ---------------------------------------------------------------------------
// 7. Effective stat helpers via upgrades
// ---------------------------------------------------------------------------
{
  const { r } = await newRoom('L7');
  const sr = roomOf(r);
  const p = () => sr.state.players.get(r.sessionId);
  // heavy_hand boosts melee
  p().upgrades.set('heavy_hand', 2);
  // need to know base melee for this character (knight)
  const baseMelee = classStats(p().character).meleeDamage;
  // Trigger melee and verify enemy HP drop includes bonus?
  const enemy = sr.state.enemies.find((e) => e.hp > 0);
  enemy.x = p().x + 1.5;
  enemy.z = p().z;
  enemy.hp = 10; // ensure not killed in one hit
  p().rotY = Math.atan2(enemy.x - p().x, enemy.z - p().z);
  const beforeHp = enemy.hp;
  sr.melee(r.sessionId);
  await waitMs(250);
  assert.equal(enemy.hp, beforeHp - (baseMelee + 2), `melee damage boosted by heavy_hand (+2)`);

  // quick_draw reduces cooldown: simulate two attacks via onInput? Check attackAt
  const now = Date.now();
  sr.attackAt.set(r.sessionId, now + 800); // reset
  // Use upgrades to compute effective CD
  p().upgrades.set('quick_draw', 1); // -15%
  // send attack after cooldown would normally be 800; with -15% should be 680?
  // We'll test via grantUpgrade path: the server's onInput uses effectiveCd.
  // So check that after an attack, attackAt delta is ~680
  // Make a fake attack via direct method would still use old? Use onInput.
  // Wait for cooldown to expire first
  sr.attackAt.set(r.sessionId, 0);
  sr.invulnUntil.set(r.sessionId, 0);
  sr.state.matchState = 'playing';
  // need to bypass blocking etc — call onInput directly with mock client
  const mockClient = { sessionId: r.sessionId };
  sr.onInput(mockClient, { dirX: 0, dirZ: 0, attack: true });
  const cd = sr.attackAt.get(r.sessionId) - Date.now();
  // 800 * 0.85 = 680
  assert.ok(cd >= 600 && cd <= 720, `quick_draw reduced cooldown to ~680 (got ${cd})`);

  r.leave();
  await waitMs(200);
}

// ---------------------------------------------------------------------------
// 8. ResetMatch clears progression (playAgain)
// ---------------------------------------------------------------------------
{
  const { r } = await newRoom('L8');
  const sr = roomOf(r);
  const p = () => sr.state.players.get(r.sessionId);
  sr.grantXp(r.sessionId, 250); // level 3
  await waitFor(() => p().level === 3, 3000, 'level 3 before reset');
  // Score win to reach gameover, then playAgain
  p().score = SERVER.match.targetScore;
  await waitFor(() => r.state.matchState === 'gameover', 3000, 'gameover before reset');
  r.send('playAgain');
  await waitFor(() => r.state.matchState === 'countdown', 3000, 'countdown after playAgain');
  // server should have reset level/xp/upgrades
  await waitMs(100);
  assert.equal(p().level, 1, 'level reset to 1 after playAgain');
  assert.equal(p().xp, 0, 'xp reset after playAgain');
  assert.equal(p().upgrades.size, 0, 'upgrades cleared after playAgain');
  assert.equal(p().pendingChoices.length, 0, 'pending cleared after playAgain');
  r.leave();
  await waitMs(200);
}

// ---------------------------------------------------------------------------
// 9. LocalRoom parity: same XP events produce same level/choices
// ---------------------------------------------------------------------------
{
  // Server: create a real room, level up, capture picks
  const { r } = await newRoom('ParityServer', 1); // archer
  const sr = roomOf(r);
  sr.grantXp(r.sessionId, 100);
  await waitFor(() => sr.state.players.get(r.sessionId).pendingChoices.length === 3, 3000, 'server pending for parity');
  const serverPicks = [...sr.state.players.get(r.sessionId).pendingChoices];
  const serverLevel = sr.state.players.get(r.sessionId).level;
  const serverXp = sr.state.players.get(r.sessionId).xp;
  r.leave();
  await waitMs(200);

  // LocalRoom: same character, same XP gain sequence
  const local = new LocalRoom();
  await local.join('ParityLocal', 1);
  local._running = false; // manual stepping like waves.test
  // ensure in playing phase
  local._countdownTimer = 0;
  local._step(0.05);
  while (local.state.matchState !== 'playing') local._step(0.05);
  const me = local.state.players.get(local.sessionId);
  // drive local XP the same way (grant 100)
  local._grantXp(100);
  assert.equal(me.level, serverLevel, 'local level matches server level after same XP');
  assert.equal(me.xp, serverXp, 'local xp matches server xp');
  // local picks are deterministic for its own sid (not same sid as server), verify via rollUpgrades
  const expectLocal = rollUpgrades(local._hashSeed(local.sessionId, me.level), me.character, new Map());
  assert.deepEqual([...me.pendingChoices], expectLocal, 'local picks match rollUpgrades for its own sid/level');
  assert.equal(me.pendingChoices.length, 3, 'local pending 3');
  // pick first of local's own picks
  const choice = [...me.pendingChoices][0];
  local._chooseUpgrade(choice);
  assert.equal(me.pendingChoices.length, 0, 'local pending cleared after pick');
  local.leave();

  // auto-pick parity: short timer
  SERVER.progression.autoPickMs = 400;
  const { r: r2 } = await newRoom('ParityAuto', 2); // mage
  const sr2 = roomOf(r2);
  sr2.grantXp(r2.sessionId, 100);
  await waitFor(() => sr2.state.players.get(r2.sessionId).pendingChoices.length === 3, 3000, 'server pending for auto parity');
  const autoPick = [...sr2.state.players.get(r2.sessionId).pendingChoices][0];
  await waitFor(() => sr2.state.players.get(r2.sessionId).pendingChoices.length === 0, 3000, 'server auto-pick');
  assert.equal(sr2.state.players.get(r2.sessionId).upgrades.get(autoPick), 1, 'server auto-pick recorded');
  r2.leave();
  await waitMs(200);

  const local2 = new LocalRoom();
  await local2.join('ParityLocalAuto', 2);
  local2._running = false;
  local2._countdownTimer = 0;
  while (local2.state.matchState !== 'playing') local2._step(0.05);
  const me2 = local2.state.players.get(local2.sessionId);
  local2._grantXp(100);
  assert.equal(me2.pendingChoices.length, 3, 'local pending for auto');
  const localAuto = [...me2.pendingChoices][0];
  // local's auto pick is deterministic for its own sid; server's auto for its sid may differ
  const expectLocalAuto = rollUpgrades(local2._hashSeed(local2.sessionId, me2.level), me2.character, new Map())[0];
  assert.equal(localAuto, expectLocalAuto, 'local auto pick matches expected for its sid');
  // advance time manually by setting deadline past and calling _checkAutoPicks
  local2._pendingUntil = performance.now() - 1;
  local2._checkAutoPicks();
  assert.equal(me2.pendingChoices.length, 0, 'local auto-pick cleared');
  assert.equal(me2.upgrades.get(localAuto), 1, 'local auto-pick recorded');
  local2.leave();
  SERVER.progression.autoPickMs = prevAutoPick;
}

// ---------------------------------------------------------------------------
// 10. Block while moving still works at level 2+ (regression)
// ---------------------------------------------------------------------------
{
  const { r } = await newRoom('L10');
  const sr = roomOf(r);
  const p = () => sr.state.players.get(r.sessionId);
  sr.grantXp(r.sessionId, 250); // level 3
  await waitFor(() => p().level === 3, 3000, 'level 3 for regression');
  // clear all pending (including queued) so movement not blocked by UI
  let guard = 0;
  while (p().pendingChoices.length > 0 && guard++ < 5) {
    const curPicks = [...p().pendingChoices];
    const cur = curPicks[0];
    r.send('chooseUpgrade', { choice: cur });
    await waitFor(() => {
      const curPending = [...p().pendingChoices];
      return curPending.length === 0 || curPending.join('|') !== curPicks.join('|');
    }, 3000, 'pending changed after pick');
    await waitMs(50);
  }
  // verify block-while-moving still reduces speed: move with and without block
  // We check that the server's movePlayers still respects blockSpeedMult
  // The test is indirect: ensure player can still move while blocking (no freeze)
  p().x = 0; p().z = 0;
  sr.inputs.set(r.sessionId, { dirX: 1, dirZ: 0 });
  p().blocking = true;
  const xBefore = p().x;
  sr.movePlayers(0.1);
  assert.ok(p().x > xBefore, 'block-while-moving: player still moves while blocking at high level');

  r.leave();
  await waitMs(200);
}

await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();

console.log('ok — phase4.test.mjs: leveling, rollUpgrades, pick/auto-pick, XP from orb/kill, scholar, effective stats, reset, local parity verified');
process.exit(0);
