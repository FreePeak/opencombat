import http from 'node:http';
import assert from 'node:assert/strict';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import ArenaRoom from '../src/server/rooms/ArenaRoom.js';
import LobbyRoom from '../src/server/rooms/LobbyRoom.js';
import { WorldState, LobbyState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp, attachHttpLogging } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import { classStats } from '../src/shared/skills.js';

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
attachHttpLogging(httpServer);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app)
});
gameServer.define('game', GameRoom);
gameServer.define('arena', ArenaRoom);
gameServer.define('lobby', LobbyRoom);
await gameServer.listen(0);
const port = httpServer.address().port;
console.log('server on', port);

const roomOfArena = (r) => [...ArenaRoom.instances].find((x) => x.roomId === r.roomId);
const roomOfLobby = (r) => [...LobbyRoom.instances].find((x) => x.roomId === r.roomId);

// Test 1: ArenaRoom direct create duel, teams, maxClients
{
  const client = new Client(`ws://localhost:${port}`);
  const room = await client.create('arena', { mode: 'duel', pve: false, roundsToWin: 2 }, WorldState);
  const sr = roomOfArena(room);
  assert.equal(sr.arenaMode, 'duel', 'duel mode');
  assert.equal(sr.pveEnabled, false, 'pve false');
  assert.equal(sr.roundsToWin, 2, 'roundsToWin 2');
  assert.equal(sr.maxClients, 2, 'duel max 2');
  await waitFor(() => room.state.arenaMode === 'duel', 2000, 'client sees duel');
  assert.equal(room.state.arenaPve, false);
  assert.equal(room.state.arenaRoundsToWin, 2);
  console.log('test1 duel create ok');
  // check enemies dead when pve false
  await waitFor(() => room.state.enemies.length > 0, 2000, 'enemies synced');
  assert.ok(room.state.enemies.every((e) => e.hp === 0), 'enemies dead when pve false');
  room.leave();
  await waitMs(200);
}

// Test 2: Arena FFA team assignment
{
  const c1 = new Client(`ws://localhost:${port}`);
  const r1 = await c1.create('arena', { mode: 'ffa', pve: false }, WorldState);
  const c2 = new Client(`ws://localhost:${port}`);
  const r2 = await c2.joinById(r1.roomId, { name: 'B' }, WorldState);
  const c3 = new Client(`ws://localhost:${port}`);
  const r3 = await c3.joinById(r1.roomId, { name: 'C' }, WorldState);
  await waitMs(200);
  const sr = roomOfArena(r1);
  // FFA each team is own index
  const p1 = sr.state.players.get(r1.sessionId);
  const p2 = sr.state.players.get(r2.sessionId);
  const p3 = sr.state.players.get(r3.sessionId);
  console.log('FFA teams', p1.team, p2.team, p3.team);
  assert.equal(p1.team, 0);
  assert.equal(p2.team, 1);
  assert.equal(p3.team, 2);
  // client sees team
  assert.equal(r1.state.players.get(r1.sessionId).team, 0);
  r1.leave(); r2.leave(); r3.leave();
  await waitMs(300);
  console.log('test2 ffa ok');
}

// Test 3: Team mode friendly fire disabled + kill scoring + round win
{
  const c1 = new Client(`ws://localhost:${port}`);
  const r1 = await c1.create('arena', { mode: 'team', pve: false, roundsToWin: 2 }, WorldState);
  const sr = roomOfArena(r1);
  await waitFor(() => r1.state.matchState === 'lobby' || r1.state.matchState === 'countdown', 3000, 'lobby or countdown');
  const c2 = new Client(`ws://localhost:${port}`);
  const r2 = await c2.joinById(r1.roomId, { name: 'T2', character: 0 }, WorldState);
  const c3 = new Client(`ws://localhost:${port}`);
  const r3 = await c3.joinById(r1.roomId, { name: 'T3' }, WorldState);
  const c4 = new Client(`ws://localhost:${port}`);
  const r4 = await c4.joinById(r1.roomId, { name: 'T4' }, WorldState);
  await waitMs(300);
  // Now we have 4 players, team assignment should be 0,1,0,1
  const teams = [...sr.state.players.values()].map(p=>p.team);
  console.log('team assignment 4 players', teams, [...sr.state.players.keys()]);
  // Wait for playing
  await waitFor(() => r1.state.matchState === 'playing', 15000, 'playing');
  console.log('playing, teams', [...sr.state.players.entries()].map(([sid,p]) => [p.name, p.team]));
  // Identify two players on same team (0) and different team
  const sids = [...sr.state.players.keys()];
  const teamMap = sr._teamAssignment;
  console.log('teamMap', [...teamMap]);
  // Find attacker and same-team victim and opposite-team victim
  let attackerSid = sids[0];
  let sameTeamSid = sids.find((s) => s!==attackerSid && teamMap.get(s)===teamMap.get(attackerSid));
  let oppTeamSid = sids.find((s) => teamMap.get(s)!==teamMap.get(attackerSid));
  console.log('attacker', attackerSid, 'same', sameTeamSid, 'opp', oppTeamSid);
  const attacker = sr.state.players.get(attackerSid);
  const sameVictim = sr.state.players.get(sameTeamSid);
  const oppVictim = sr.state.players.get(oppTeamSid);
  // Place attacker and sameTeam victim close, facing
  attacker.x = 0; attacker.z = 0; attacker.rotY = 0;
  sameVictim.x = 0; sameVictim.z = 2; sameVictim.hp = 80;
  oppVictim.x = 2; oppVictim.z = 0;
  // Ensure block not active, invuln cleared
  sr.invulnUntil.set(sameTeamSid, 0);
  sr.invulnUntil.set(oppTeamSid, 0);
  // Attack same team: should NOT damage
  const sameHpBefore = sameVictim.hp;
  attacker.rotY = Math.atan2(sameVictim.x - attacker.x, sameVictim.z - attacker.z);
  sr.melee(attackerSid);
  await waitMs(100);
  console.log('same team hp before', sameHpBefore, 'after', sameVictim.hp);
  assert.equal(sameVictim.hp, sameHpBefore, 'team friendly fire blocked');

  // Attack opposite team: should damage and potentially kill
  oppVictim.hp = 10; // low hp so one melee kills (knight 15 damage)
  // Need attacker to be knight (character 0) to have 15 pvp damage; ensure attacker is knight
  attacker.character = 0;
  oppVictim.x = attacker.x + 1.5; oppVictim.z = attacker.z;
  attacker.rotY = Math.atan2(oppVictim.x - attacker.x, oppVictim.z - attacker.z);
  sr.invulnUntil.set(oppTeamSid, 0);
  const oppHpBefore = oppVictim.hp;
  const scoreBefore = attacker.score;
  sr.melee(attackerSid);
  await waitMs(100);
  console.log('opp victim hp before', oppHpBefore, 'after', oppVictim.hp, 'attacker score before', scoreBefore, 'after', attacker.score);
  assert.equal(oppVictim.hp, 0, 'opp victim killed');
  assert.equal(attacker.score, scoreBefore + 10, 'kill score 10 awarded');

  // Test projectile friendly fire also blocked? Use archer
  // Change attacker to archer for projectile test
  attacker.character = 1;
  sameVictim.hp = 80;
  sr.invulnUntil.set(sameTeamSid, 0);
  attacker.x = 0; attacker.z = 0;
  sameVictim.x = 0; sameVictim.z = 5;
  attacker.rotY = Math.atan2(sameVictim.x - attacker.x, sameVictim.z - attacker.z);
  // spawn projectile toward same team
  const atk = (await import('../src/shared/classes.js')).attackFor(attacker.character);
  sr.spawnProjectile(attackerSid, attacker, atk);
  // step projectile a bit
  sr.updateProjectiles(0.1);
  console.log('same team after projectile hp', sameVictim.hp);
  assert.equal(sameVictim.hp, 80, 'projectile friendly fire blocked');

  r1.leave(); r2.leave(); r3.leave(); r4.leave();
  await waitMs(300);
  console.log('test3 team friendly fire + kill scoring ok');
}

// Test 4: Round win and reset (duel)
{
  const c1 = new Client(`ws://localhost:${port}`);
  const r1 = await c1.create('arena', { mode: 'duel', pve: false, roundsToWin: 2, roundTargetScore: 10 }, WorldState);
  const sr = roomOfArena(r1);
  const c2 = new Client(`ws://localhost:${port}`);
  const r2 = await c2.joinById(r1.roomId, { name: 'Duelist2' }, WorldState);
  await waitFor(() => r1.state.matchState === 'playing', 15000, 'duel playing');
  console.log('duel playing, targetScore', sr.roundTargetScore);
  // Give player1 score to win round 1 via orb or direct
  const p1 = sr.state.players.get(r1.sessionId);
  p1.score = 10; // reaches target
  // Need at least one living player on winning side (p1 alive)
  p1.hp = 100;
  // Wait for round win processing (next tick)
  await waitMs(600);
  console.log('after round win 1', r1.state.matchState, 'round', r1.state.arenaRound, 'roundWins', [...r1.state.arenaRoundWins.entries()]);
  assert.equal(r1.state.arenaRound, 2, 'round incremented to 2');
  assert.equal(r1.state.arenaRoundWins.get(r1.sessionId), 1, 'p1 has 1 round win');
  assert.equal(r1.state.matchState, 'countdown', 'countdown for round 2');
  await waitFor(() => r1.state.matchState === 'playing', 15000, 'playing round2');
  // Win second round
  const p1b = sr.state.players.get(r1.sessionId);
  p1b.score = 10;
  await waitMs(600);
  console.log('after round win 2', r1.state.matchState, r1.state.winnerId, r1.state.winnerName);
  assert.equal(r1.state.matchState, 'gameover', 'gameover after 2 rounds');
  assert.equal(r1.state.winnerId, r1.sessionId, 'winner is p1');
  // Test auto-reset on join during gameover with single player? Not needed
  // Test playAgain resets
  r1.send('playAgain');
  await waitFor(() => r1.state.matchState === 'countdown', 3000, 'playAgain countdown');
  console.log('playAgain ok, round', r1.state.arenaRound);
  assert.equal(r1.state.arenaRound, 1, 'round reset to 1 after playAgain');
  assert.equal(r1.state.arenaRoundWins.size, 0, 'roundWins cleared');
  r1.leave(); r2.leave();
  await waitMs(300);
  console.log('test4 round win ok');
}

// Test 5: PvE toggle false vs true
{
  const c1 = new Client(`ws://localhost:${port}`);
  const r1 = await c1.create('arena', { mode: 'ffa', pve: false }, WorldState);
  assert.ok(r1.state.enemies.every((e)=>e.hp===0), 'pve false enemies dead');
  r1.leave(); await waitMs(200);
  const c2 = new Client(`ws://localhost:${port}`);
  const r2 = await c2.create('arena', { mode: 'ffa', pve: true }, WorldState);
  await waitMs(200);
  const alive = [...r2.state.enemies].filter((e)=>e.hp>0).length;
  console.log('pve true alive enemies', alive);
  assert.ok(alive >= 3, 'pve true has alive enemies');
  r2.leave(); await waitMs(200);
  console.log('test5 pve toggle ok');
}

// Test 6: Lobby queue -> redirect
{
  const c1 = new Client(`ws://localhost:${port}`);
  const lobby1 = await c1.joinOrCreate('lobby', { name: 'LobbyA', character: 0 }, LobbyState);
  const c2 = new Client(`ws://localhost:${port}`);
  const lobby2 = await c2.joinOrCreate('lobby', { name: 'LobbyB', character: 1 }, LobbyState);
  // Both queue for duel
  const p1Redirect = new Promise((res) => lobby1.onMessage('redirect', (data) => { console.log('lobby1 redirect', data); res(data); }));
  const p2Redirect = new Promise((res) => lobby2.onMessage('redirect', (data) => { console.log('lobby2 redirect', data); res(data); }));
  lobby1.send('queue', { mode: 'duel', pve: false, roundsToWin: 2 });
  lobby2.send('queue', { mode: 'duel', pve: false, roundsToWin: 2 });
  const [res1, res2] = await Promise.all([p1Redirect, p2Redirect]);
  console.log('both redirected', res1.roomId, res2.roomId);
  assert.equal(res1.roomId, res2.roomId, 'same arena room');
  // Consume reservation
  const arena1 = await c1.consumeSeatReservation(res1);
  const arena2 = await c2.consumeSeatReservation(res2);
  // Need to wait for arena to be ready? The reservation already contains session; but we consumed separately – might need to use different consumption?
  // Actually consumeSeatReservation on same roomId for two clients: each had its own reservation object with its own sessionId
  // The above used res1 for both? We did separate reservations, each client gets its own reservation with same roomId but different sessionId
  // After consume, they should be in same arena room
  await waitMs(500);
  console.log('arena1 state', arena1.state?.arenaMode, arena1.state?.players.size);
  console.log('arena2 state', arena2.state?.arenaMode, arena2.state?.players.size);
  assert.equal(arena1.state.arenaMode, 'duel');
  // Wait for playing?
  await waitFor(() => arena1.state.matchState === 'playing' || arena1.state.matchState === 'countdown', 10000, 'arena playing');
  console.log('lobby redirect success, arena mode', arena1.state.arenaMode);
  arena1.leave(); arena2.leave();
  lobby1.leave(); lobby2.leave();
  await waitMs(300);
  console.log('test6 lobby ok');
}

console.log('ALL ARENA TESTS PASSED');
await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();
process.exit(0);
