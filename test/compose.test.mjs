// Systems-compose pin (CYCLE-T): the flagship bullet-heaven chain —
// shooter/boss kills leave CHARGED orbs at their corpses, a magnet holder
// converges them, and collection pays base + stored XP through the normal
// pickup path. Every link is unit-pinned elsewhere; this file proves the
// COMPOSITION in one real GameRoom. Run: node --test test/compose.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';

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
resetRateLimit();
const httpServer = http.createServer();
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app)
});
gameServer.define('game', GameRoom);
await gameServer.listen(0);
const port = httpServer.address().port;
const roomOf = (r) => [...GameRoom.instances].find((x) => x.roomId === r.roomId);

{
  const r = await new Client(`ws://localhost:${port}`)
    .create('game', { name: 'Composer' }, WorldState);
  const sr = roomOf(r);
  try {
    await waitFor(() => sr.state.matchState === 'playing', 8000, 'match playing');
    const me = sr.state.players.get(r.sessionId);
    me.x = 0; me.z = 0; me.rotY = Math.PI / 2;

    // Wave 5 fields shooters (k>=3) — kill one through the shared hit path.
    sr.spawnWave(5);
    const shooter = [...sr.state.enemies]
      .find((e) => e.archetype === 'Shooter' && e.hp > 0);
    assert.ok(shooter, 'wave-5 fields a Shooter');
    sr.hitEnemy(shooter, shooter.hp, me.x, me.z, r.sessionId);
    assert.equal(shooter.hp, 0, 'shooter killed via shared hitEnemy');

    // Link 1: the kill charged an orb AT THE CORPSE with xpPerKill.
    assert.equal(sr.orbCharges.size, 1, 'one charge from one credited kill');
    const [charged] = [...sr.orbCharges.keys()];
    assert.equal(sr.orbCharges.get(charged), SERVER.progression?.xpPerKill ?? 30);
    assert.equal(charged.charge, SERVER.progression?.xpPerKill ?? 30,
      'schema mirror exposed for rendering');
    assert.equal(charged.x, shooter.x);
    assert.equal(charged.z, shooter.z);

    // Link 2: magnet holder closes to within pull range, then converges
    // WITHOUT further walking (pull radius 8 < spawn-away distance 12).
    me.x = charged.x + 5;
    me.z = charged.z;
    me.effects.set('magnet', SERVER.powerUps.magnet.durationMs);
    const xpBefore = me.xp;
    const scoreBefore = me.score;
    let ticks = 0;
    while (sr.orbCharges.size > 0 && ticks++ < 200) sr.updatePickups(0.1);
    assert.equal(sr.orbCharges.size, 0, 'magnet swept the charge');
    assert.ok(me.xp > xpBefore, `charge XP paid (${xpBefore} -> ${me.xp})`);
    // Base payout rode along exactly once.
    assert.equal(me.score - scoreBefore, SERVER.orb.score,
      'orb base score paid once during convergence');

    // Link 3: elite kill on wave 5 composes payKillXp doubling into the drop.
    sr.spawnWave(5); // fresh wave; slot 0 is the Swift elite
    const elite = sr.state.enemies[0];
    assert.equal(elite.elite, 'Swift');
    sr.hitEnemy(elite, elite.hp, me.x, me.z, r.sessionId);
    const bossCharge = [...sr.orbCharges.values()][0];
    assert.equal(bossCharge, (SERVER.progression?.xpPerKill ?? 30) * 2,
      'elite kill charges DOUBLE into its corpse orb');
    // Re-arm beside the elite corpse (spawns >=12u away) and sweep its drop.
    const [eliteOrb] = [...sr.orbCharges.keys()];
    me.x = eliteOrb.x + 3;
    me.z = eliteOrb.z;
    me.effects.set('magnet', SERVER.powerUps.magnet.durationMs);
    const xpMid = me.xp;
    let t2 = 0;
    while (sr.orbCharges.size > 0 && t2++ < 200) sr.updatePickups(0.1);
    assert.equal(sr.orbCharges.size, 0, 'elite drop swept');
    assert.ok(me.xp > xpMid, `elite charge XP paid (${xpMid} -> ${me.xp})`);

    r.leave();
  } catch (e) {
    try { r.leave(); } catch {}
    throw e;
  }
}

await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();

console.log('ok — compose.test.mjs: shooter kill -> corpse-charge -> magnet sweep -> payout; elite doubles the drop');
process.exit(0);
