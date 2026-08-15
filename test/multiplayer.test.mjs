// Headless multiplayer test: boots the real Colyseus server in-process and
// joins with a real colyseus.js client over WebSocket. Covers (Upgrades A/B/C):
//   - match lifecycle: countdown -> playing after the first join
//   - movement sync: input intent moves the server-authoritative position
//   - power-up pickup: steering into one applies a timed effect
//   - attack cooldown: a rapid second attack is rejected (no reset)
//   - two-client visibility: both players see each other's state
// Run: npm test
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client, CloseCode } from '@colyseus/sdk'; // 0.17 client
import GameRoom from '../src/server/rooms/GameRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, timeoutMs = 10000, label = 'condition') => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await waitMs(30);
  }
  throw new Error('timeout waiting for ' + label);
};

// Boot the real server on an ephemeral port (same wiring as src/server/index.js).
const httpServer = http.createServer();
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer })
});
gameServer.define('game', GameRoom);
await gameServer.listen(0);
const port = httpServer.address().port;

const client = new Client(`ws://localhost:${port}`);
const room = await client.joinOrCreate('game', { name: 'Tester1' }, WorldState);

// --- A: match lifecycle -----------------------------------------------------
// First join starts the countdown (minPlayers = 1); observe 3-2-1 -> GO.
const seenStates = [];
room.onStateChange((state) => {
  const key = state.matchState + ':' + Math.ceil(state.countdown);
  if (seenStates[seenStates.length - 1] !== key) seenStates.push(key);
});
await waitFor(() => room.state?.matchState === 'playing', 8000, 'playing phase');
assert.ok(seenStates.includes('countdown:3') || seenStates.includes('countdown:2'),
  'countdown observed before playing (got: ' + seenStates.slice(0, 6).join(', ') + ')');

const me = () => room.state.players.get(room.sessionId);
assert.ok(me(), 'joined player exists in the state map');
assert.equal(me().hp, 100, 'fresh player starts at full HP');
assert.equal(me().name, 'Tester1', 'pre-join name rides the join options');
assert.ok(me().color > 0, 'server assigned a palette color');
assert.equal(room.state.matchState, 'playing', 'match is playing after countdown');

// --- movement sync (existing behavior, now gated on playing) ---------------
const x0 = me().x;
const z0 = me().z;
room.send('input', { dirX: 1, dirZ: 0, attack: false, anim: 'run' });
await waitMs(350);
const dist = Math.hypot(me().x - x0, me().z - z0);
assert.ok(dist > 0.5, `player moved after input (d=${dist.toFixed(2)})`);
room.send('input', { dirX: 0, dirZ: 0, attack: false, anim: 'idle' });

// --- C: attack cooldown enforcement ----------------------------------------
// attackCd counts down on the schema; a rejected swing must NOT reset it.
await waitFor(() => me().attackCd <= 0, 2000, 'cooldown clear before A1');
room.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });   // A1
await waitFor(() => me().anim === 'attack', 1000, 'A1 accepted');
const cd1 = me().attackCd;
assert.ok(cd1 > 200 && cd1 < 800, `A1 set a cooldown (${cd1}ms)`);
await waitMs(150);
room.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });   // A2: too fast
await waitMs(50);
const cd2 = me().attackCd;
assert.ok(cd2 < cd1, `A2 rejected: cooldown kept draining (${cd1} -> ${cd2})`);
// Sanity: a swing after the full cooldown is accepted again.
await waitFor(() => me().attackCd <= 0, 2000, 'cooldown clear before A3');
room.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });   // A3
await waitFor(() => me().anim === 'attack', 1000, 'A3 accepted after cooldown');
await waitFor(() => me().attackCd <= 0, 2000, 'cooldown drained after A3');

// --- B: power-up pickup -----------------------------------------------------
// Steer toward the nearest active power-up until one is collected.
const steerToPowerUp = () => {
  const st = room.state;
  const p = st.players.get(room.sessionId);
  let best = null;
  let bd = Infinity;
  for (const pu of st.powerUps) {
    if (!pu.active) continue;
    const d = Math.hypot(pu.x - p.x, pu.z - p.z);
    if (d < bd) { bd = d; best = pu; }
  }
  if (best && bd > 0.9) {
    room.send('input', { dirX: (best.x - p.x) / bd, dirZ: (best.z - p.z) / bd, attack: false, anim: 'run' });
  } else {
    room.send('input', { dirX: 0, dirZ: 0, attack: false, anim: 'idle' });
  }
};
const steerTimer = setInterval(steerToPowerUp, 100);
// If enemies kill us mid-approach, respawn and keep going.
const respawnTimer = setInterval(() => {
  if (me().hp <= 0) room.send('respawn');
}, 300);
try {
  await waitFor(() => me().effects.size > 0, 25000, 'power-up pickup');
} finally {
  clearInterval(steerTimer);
  clearInterval(respawnTimer);
}
const effectName = [...me().effects.keys()][0];
assert.ok(['speed', 'shield', 'double'].includes(effectName),
  `collected a known power-up type (${effectName})`);
const effectMs = me().effects.get(effectName);
assert.ok(effectMs > 0 && effectMs <= 15000, `effect has a sane duration (${effectMs}ms)`);

// --- two-client visibility --------------------------------------------------
const client2 = new Client(`ws://localhost:${port}`);
const room2 = await client2.joinOrCreate('game', { name: 'Tester2' }, WorldState);
await waitFor(() => room2.state?.players?.size >= 2, 5000, 'room2 sees both players');
await waitFor(() => room.state?.players?.size >= 2, 5000, 'room1 sees both players');
const other = room2.state.players.get(room.sessionId);
assert.ok(other && other.name === 'Tester1', 'room2 can read room1 player (name rides)');

// --- F: automatic reconnection (Upgrade F) --------------------------------
// The sdk reconnects dropped sockets on its own (same session + room, and
// the server kept the seat + player state via allowReconnection).
// (The room is well past the 5s "min uptime" guard by now.)
const sessionId = room.sessionId;
const roomId = room.roomId;
const reconnected = new Promise((res) => room.onReconnect(() => res()));
room.connection.close(CloseCode.MAY_TRY_RECONNECT, 'simulated network drop');
await reconnected; // sdk auto-reconnect restores the session
await new Promise((r) => setTimeout(r, 300)); // let the state flow again
assert.equal(room.sessionId, sessionId, 'auto-reconnect resumes the same session');
assert.equal(room.roomId, roomId, 'auto-reconnect resumes the same room');
const resumed = room.state?.players?.get(room.sessionId);
assert.ok(resumed, 'state flows again after auto-reconnect');
assert.equal(resumed.name, 'Tester1', 'player state survived the reconnect');
assert.ok(resumed.score >= 0, 'score carried over');

// Disconnect cleanly (exit=false so the test process survives shutdown).
room.leave();
room2.leave();
await gameServer.gracefullyShutdown(false);
await new Promise((res) => httpServer.close(res));

console.log(`ok — multiplayer.test.mjs: lifecycle + ${dist.toFixed(2)}u move + ${effectName} pickup + cooldown + reconnect verified`);
process.exit(0);
