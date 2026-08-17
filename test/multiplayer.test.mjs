// Headless multiplayer test: boots the real Colyseus server in-process and
// joins with a real colyseus.js client over WebSocket. Covers:
//   - match lifecycle: countdown -> playing after the first join
//   - movement sync: input intent moves the server-authoritative position
//   - power-up pickup: steering into one applies a timed effect
//   - attack cooldown: a rapid second attack is rejected (no reset)
//   - two-client visibility: both players see each other's state
//   - automatic reconnection (same session + state after a socket drop)
//   - GHOST: dead players cannot move / collect / score / attack / win
//   - ATTACK GATE: swings only work while the match is playing
//   - RESPAWN: effects cleared, hp restored, spawn invulnerability set
//   - WIN: gameover only via score/timer with living players; play-again
//     fully resets state; join-during-gameover auto-restarts an empty room
//   - HEALTH: /healthz shape, /metrics, static whitelist + cache headers
// Run: npm test
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client, CloseCode } from '@colyseus/sdk'; // 0.17 client
import GameRoom from '../src/server/rooms/GameRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp, attachHttpLogging } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import { joinErrorMessage } from '../src/joinError.js';

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, timeoutMs = 10000, label = 'condition') => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await waitMs(30);
  }
  throw new Error('timeout waiting for ' + label);
};

// Tests join from one IP: raise the per-IP join bucket so the suite is not
// rate-limited. (The bucket itself is verified by unit-level assertions.)
SERVER.rateLimit.capacity = 10000;

// Boot the real server on an ephemeral port (same wiring as src/server/index.js).
const httpServer = http.createServer();
attachHttpLogging(httpServer);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app)
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
await waitFor(() => room.state?.matchState === 'playing', 15000, 'playing phase');
assert.ok(seenStates.includes('countdown:3') || seenStates.includes('countdown:2'),
  'countdown observed before playing (got: ' + seenStates.slice(0, 6).join(', ') + ')');

const me = () => room.state.players.get(room.sessionId);
assert.ok(me(), 'joined player exists in the state map');
assert.equal(me().hp, 100, 'fresh player starts at full HP');
assert.equal(me().name, 'Tester1', 'pre-join name rides the join options');
assert.equal(me().character, 0, 'join without a character defaults to swordsman');
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
const room2 = await client2.joinOrCreate('game', { name: 'Tester2', character: 2 }, WorldState);
await waitFor(() => room2.state?.players?.size >= 2, 5000, 'room2 sees both players');
await waitFor(() => room.state?.players?.size >= 2, 5000, 'room1 sees both players');
const other = room2.state.players.get(room.sessionId);
assert.ok(other && other.name === 'Tester1', 'room2 can read room1 player (name rides)');

// --- character selection ------------------------------------------------------
// The chosen index rides the join options and is visible to every client;
// out-of-range values are clamped server-side to the roster bounds.
assert.equal(room2.state.players.get(room2.sessionId).character, 2, 'chosen character rides the join options');
assert.equal(room.state.players.get(room2.sessionId).character, 2, 'other clients see the chosen character');
const client3 = new Client(`ws://localhost:${port}`);
const room3 = await client3.joinOrCreate('game', { name: 'Tester3', character: 99 }, WorldState);
await waitFor(() => room3.state?.players?.get(room3.sessionId), 5000, 'room3 player exists');
assert.equal(room3.state.players.get(room3.sessionId).character, 3, 'out-of-range character clamped to the roster');
room3.leave();

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

// Disconnect the first pair cleanly; later suites boot their own rooms.
room.leave();
room2.leave();
await waitMs(200);

// ============================================================================
// Helpers for the gameplay-bug suites.
// ============================================================================
const roomOf = (r) => [...GameRoom.instances].find((x) => x.roomId === r.roomId);
const newRoom = async (name) => {
  const c = new Client(`ws://localhost:${port}`);
  const r = await c.create('game', { name }, WorldState);
  await waitFor(() => r.state?.matchState === 'playing', 15000, `${name}: playing phase`);
  return { c, r };
};
const joinRoom = async (r, name) => {
  const c = new Client(`ws://localhost:${port}`);
  const r2 = await c.joinById(r.roomId, { name }, WorldState);
  return { c, r: r2 };
};
const half = SERVER.world.size / 2;

// ============================================================================
// GHOST: a dead player (hp <= 0) is frozen, collects nothing, cannot attack
// or win, and enemies ignore the corpse. Only the respawn click works.
// ============================================================================
{
  const a = await newRoom('GhostHost');          // living player A
  const b = await joinRoom(a.r, 'Corpse');       // soon-to-be corpse B
  await waitFor(() => b.r.state?.players?.size >= 2, 5000, 'both players in room');

  const sr = roomOf(a.r);
  const aState = () => sr.state.players.get(a.r.sessionId);
  const bState = () => sr.state.players.get(b.r.sessionId); // SERVER-side (authoritative)
  const bClient = () => b.r.state.players.get(b.r.sessionId);

  // Isolate: A in one corner, B in the opposite corner, A invulnerable so
  // contact damage cannot kill the only living player mid-test.
  aState().x = -half + 3; aState().z = -half + 3;
  sr.invulnUntil.set(a.r.sessionId, Date.now() + 120000);

  // Kill B (simulated enemy damage). The corpse may have spawned on top of
  // an orb and collected it in the tick between joining and this mutation —
  // reset the score so the collection assertions below start from a clean 0.
  bState().hp = 0;
  bState().score = 0;
  await waitFor(() => bClient().hp === 0, 3000, 'corpse hp 0 synced to client');

  // 1. Frozen: movement input is ignored.
  bState().x = half - 3; bState().z = half - 3; // settle the corpse corner first
  await waitMs(120);
  const bx = bClient().x, bz = bClient().z;
  b.r.send('input', { dirX: 1, dirZ: 0, attack: false, anim: 'run' });
  await waitMs(400);
  assert.equal(bClient().x, bx, 'corpse x unchanged under movement input');
  assert.equal(bClient().z, bz, 'corpse z unchanged under movement input');

  // 2. Cannot collect orbs: drop one on the corpse, score must stay 0 and
  //    the orb must NOT be consumed (no respawn teleport).
  const orb = sr.state.orbs[0];
  orb.x = bClient().x; orb.z = bClient().z;
  await waitMs(250);
  assert.equal(bClient().score, 0, 'corpse gains no orb score');
  assert.ok(Math.hypot(orb.x - bClient().x, orb.z - bClient().z) < 0.01,
    'orb is not consumed by the corpse');

  // 3. Cannot pick up power-ups.
  const pu = sr.state.powerUps[0];
  pu.x = bClient().x; pu.z = bClient().z; pu.active = true;
  await waitMs(250);
  assert.equal(bClient().effects.size, 0, 'corpse gains no power-up effects');
  assert.equal(pu.active, true, 'power-up not consumed by the corpse');

  // 4. Cannot attack: an enemy in range + in front takes no damage, and no
  //    cooldown is armed (the swing never happened).
  const enemy = sr.state.enemies[0];
  enemy.x = bClient().x + 1; enemy.z = bClient().z;
  bState().rotY = Math.atan2(enemy.x - bClient().x, enemy.z - bClient().z); // face it
  const ehp = enemy.hp;
  b.r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitMs(200);
  assert.equal(enemy.hp, ehp, 'corpse swing does no damage');
  assert.equal(bClient().attackCd, 0, 'corpse swing arms no cooldown');

  // 5. Enemies ignore the corpse: they chase the living player (A), not B.
  enemy.x = bClient().x + 1; enemy.z = bClient().z;
  const dBefore = Math.hypot(bClient().x - enemy.x, bClient().z - enemy.z); // ~1
  await waitMs(500);
  const dAfter = Math.hypot(bClient().x - enemy.x, bClient().z - enemy.z);
  assert.ok(dAfter > dBefore + 0.4,
    `enemy left the corpse alone (dist ${dBefore.toFixed(2)} -> ${dAfter.toFixed(2)})`);
  assert.equal(bClient().hp, 0, 'corpse takes no contact damage');
  assert.equal(bClient().x, bx, 'corpse not knocked back');

  // 6. RESPAWN: click-to-respawn restores hp, clears effects, sets invuln.
  //    (Give the corpse a buff first — it must die with it.)
  bState().effects.set('double', 10000);
  b.r.send('respawn');
  await waitFor(() => bClient().hp === 100, 3000, 'corpse respawned to full hp');
  assert.equal(bClient().effects.size, 0, 'effects cleared on respawn');
  assert.ok(sr.invulnUntil.get(b.r.sessionId) > Date.now(), 'spawn invulnerability set');
  assert.equal(bClient().score, 0, 'respawn keeps score (still 0 here)');

  // 7. Cannot win: kill again, hand it the target score — no game over.
  bState().hp = 0;
  bState().score = SERVER.match.targetScore;
  await waitMs(700);
  assert.equal(b.r.state.matchState, 'playing', 'dead player cannot trigger the win');

  b.r.leave();
  a.r.leave();
}

// ============================================================================
// ATTACK GATE: melee is only valid while matchState === 'playing'.
// ============================================================================
{
  // (a) CONTROL — swing during playing deals damage.
  const { r } = await newRoom('Gate');
  const sr = roomOf(r);
  const p = () => sr.state.players.get(r.sessionId);
  const enemy = sr.state.enemies[0];
  enemy.x = p().x + 2; enemy.z = p().z;          // dist 2 < attackRange 2.6
  p().rotY = Math.atan2(2, 0);                    // +X facing, enemy in front
  const hp0 = enemy.hp;
  r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitFor(() => enemy.hp < hp0, 2000, 'swing during playing deals damage');
  assert.equal(enemy.hp, hp0 - 1, 'one melee hit during playing');
  r.leave();
}
{
  // (b) GAME OVER — swing on the results screen does nothing.
  const { r } = await newRoom('Gate2');
  const sr = roomOf(r);
  const p = () => sr.state.players.get(r.sessionId);
  p().score = SERVER.match.targetScore;
  await waitFor(() => r.state.matchState === 'gameover', 3000, 'score win');
  const enemy = sr.state.enemies[0];
  enemy.x = p().x + 2; enemy.z = p().z;
  p().rotY = Math.atan2(2, 0);
  const hp = enemy.hp;
  r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitMs(200);
  assert.equal(enemy.hp, hp, 'swing on the gameover screen does no damage');
  assert.equal(p().attackCd, 0, 'gameover swing arms no cooldown');
  r.leave();
}
{
  // (c) COUNTDOWN — swing during 3-2-1 does nothing. Reach the countdown
  // deterministically: playAgain resets a finished match into countdown.
  const { r } = await newRoom('Gate3');
  const sr = roomOf(r);
  const p = () => sr.state.players.get(r.sessionId);
  p().score = SERVER.match.targetScore;
  await waitFor(() => r.state.matchState === 'gameover', 3000, 'gameover for reset');
  r.send('playAgain');
  await waitFor(() => r.state.matchState === 'countdown', 3000, 'play again -> countdown');
  const enemy = sr.state.enemies[0];
  enemy.x = p().x + 2; enemy.z = p().z;
  p().rotY = Math.atan2(2, 0);
  const hp = enemy.hp;
  r.send('input', { dirX: 0, dirZ: 0, attack: true, anim: 'attack' });
  await waitMs(200);
  assert.equal(enemy.hp, hp, 'swing during countdown does no damage');
  assert.equal(p().attackCd, 0, 'countdown swing arms no cooldown');
  r.leave();
}

// ============================================================================
// WIN: gameover only via score/timer with living players; play-again fully
// resets state; join-during-gameover auto-restarts an empty room.
// ============================================================================
{
  // 1. Score win with a living player.
  const a = await newRoom('Winner');
  const sr = roomOf(a.r);
  sr.state.players.get(a.r.sessionId).score = SERVER.match.targetScore;
  await waitFor(() => a.r.state.matchState === 'gameover', 3000, 'score win ends match');
  assert.equal(a.r.state.winnerId, a.r.sessionId, 'winner sessionId broadcast');
  assert.equal(a.r.state.winnerName, 'Winner', 'winner name broadcast');

  // 2. Swing on the gameover screen (also covered above) + play-again reset.
  const p = () => sr.state.players.get(a.r.sessionId);
  p().effects.set('shield', 15000);
  p().hp = 30;
  a.r.send('playAgain');
  await waitFor(() => a.r.state.matchState === 'countdown', 3000, 'play again -> countdown');
  assert.equal(sr.state.winnerId, '', 'winnerId cleared on play again');
  assert.equal(sr.state.winnerName, '', 'winnerName cleared on play again');
  assert.equal(p().hp, 100, 'hp restored on play again');
  assert.equal(p().score, 0, 'score reset on play again');
  assert.equal(p().effects.size, 0, 'effects cleared on play again');
  a.r.leave();
}
{
  // 3. Timed mode ending with NO players in the room: guarded winnerId.
  const prevDuration = SERVER.match.matchDurationSeconds;
  SERVER.match.matchDurationSeconds = 2;
  let timedRoom;
  try {
    const t = await newRoom('Timer');
    timedRoom = t;
    const sr = roomOf(t.r);
    await t.r.leave(); // all players gone mid-match
    await waitFor(() => sr.state.players.size === 0, 3000, 'player removed');
    await waitFor(() => sr.state.matchState === 'gameover', 6000, 'timed end fires');
    assert.equal(sr.state.winnerId, '', 'timed end with no players -> empty winnerId');
    assert.equal(sr.state.winnerName, '', '...and empty winnerName');
    assert.ok(!t.r.state?.winnerId || t.r.state.winnerId === '',
      'client sees no null winnerId');

    // 4. Join during gameover: an empty gameover room auto-restarts.
    const late = await joinRoom(t.r, 'Latecomer');
    await waitFor(() => roomOf(t.r).state.matchState === 'countdown', 3000,
      'empty gameover room auto-restarts on join');
    assert.equal(roomOf(t.r).state.winnerId, '', 'auto-restart clears the old winner');
    assert.equal(roomOf(t.r).state.players.get(late.r.sessionId).hp, 100, 'latecomer at full hp');
    late.r.leave();
  } finally {
    SERVER.match.matchDurationSeconds = prevDuration;
    timedRoom?.r.leave();
  }
}

// ============================================================================
// HEALTH / OPS: healthz shape, metrics, static whitelist, cache headers.
// ============================================================================
{
  const base = `http://localhost:${port}`;

  // Keep one live player so /healthz + /metrics report non-zero counters.
  const host = await newRoom('HealthHost');

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200, '/healthz status');
  const hb = await health.json();
  assert.equal(hb.ok, true, '/healthz ok flag');
  assert.ok(Number.isInteger(hb.rooms) && hb.rooms >= 1, `/healthz rooms (${hb.rooms})`);
  assert.ok(Number.isInteger(hb.players) && hb.players >= 1, `/healthz players (${hb.players})`);
  assert.ok(Number.isFinite(hb.uptime) && hb.uptime >= 0, `/healthz uptime (${hb.uptime})`);

  const metrics = await fetch(`${base}/metrics`);
  assert.equal(metrics.status, 200, '/metrics status');
  const mtext = await metrics.text();
  for (const key of ['opengame_rooms', 'opengame_players', 'opengame_tick_ms', 'opengame_inputs_per_sec']) {
    assert.ok(mtext.includes(key), `/metrics exposes ${key}`);
  }
  host.r.leave();

  // Client boot config injection.
  const envjs = await fetch(`${base}/env.js`);
  assert.equal(envjs.status, 200, '/env.js status');
  const envText = await envjs.text();
  assert.ok(envText.includes('window.__OPENGAME__'), '/env.js injects the boot config');

  // Dev live reload (NODE_ENV != production in this test process): the SSE
  // endpoint exists and index.html carries the reloader script.
  const reloadAc = new AbortController();
  try {
    const reload = await fetch(`${base}/__reload`, { signal: reloadAc.signal });
    assert.equal(reload.status, 200, '/__reload status');
    assert.match(reload.headers.get('content-type') || '', /text\/event-stream/, 'SSE content type');
  } finally {
    reloadAc.abort(); // close the stream
  }
  const idxBody = await (await fetch(`${base}/`)).text();
  assert.ok(idxBody.includes('/__reload'), 'dev index.html injects the live-reload script');

  // Static whitelist: index.html + assets + client modules only.
  const idx = await fetch(`${base}/`);
  assert.equal(idx.status, 200, 'index.html served');
  assert.match(idx.headers.get('cache-control') || '', /no-cache/, 'index.html no-cache');

  const glb = await fetch(`${base}/assets/characters/adventurer.glb`);
  assert.equal(glb.status, 200, 'assets served');
  assert.match(glb.headers.get('cache-control') || '', /max-age/, 'assets cacheable');

  const schema = await fetch(`${base}/src/server/schema/StateSchema.js`);
  assert.equal(schema.status, 200, 'shared client/server schema served');

  // The client's offline sim (src/LocalRoom.js) imports these two server
  // modules — a 404 here breaks the whole ES-module graph on page boot.
  for (const shared of ['/src/server/config.js', '/src/server/movement.js']) {
    const res = await fetch(`${base}${shared}`);
    assert.equal(res.status, 200, `${shared} served (client local-sim import)`);
  }

  for (const leaked of ['/package.json', '/package-lock.json', '/README.md',
    '/node_modules/express/package.json',
    '/src/server/rooms/GameRoom.js', '/test/multiplayer.test.mjs']) {
    const res = await fetch(`${base}${leaked}`);
    assert.equal(res.status, 404, `${leaked} is NOT exposed`);
  }
}
{
  // Per-IP join rate limiting: with a tiny bucket, the third join from the
  // same IP (all test clients share 127.0.0.1) is rejected at onAuth.
  const prevCapacity = SERVER.rateLimit.capacity;
  SERVER.rateLimit.capacity = 2;
  let r1, r2;
  try {
    const c1 = new Client(`ws://localhost:${port}`);
    r1 = await c1.create('game', { name: 'RL1' }, WorldState); // token 1
    const c2 = new Client(`ws://localhost:${port}`);
    r2 = await c2.create('game', { name: 'RL2' }, WorldState); // token 2
    const c3 = new Client(`ws://localhost:${port}`);
    await assert.rejects(() => c3.create('game', { name: 'RL3' }, WorldState),
      /too many join attempts/, 'third join from one IP is rate-limited');
    c3.connection?.close();
  } finally {
    SERVER.rateLimit.capacity = prevCapacity;
    resetRateLimit(); // depleted buckets must not leak into later scenarios
    r1?.leave();
    r2?.leave();
  }
}
{
  // Empty-room cleanup: a room with no players is disposed after the TTL,
  // so abandoned rooms (including stale gameover ones) cannot pile up.
  const prevTtl = SERVER.match.emptyRoomTtlMs;
  SERVER.match.emptyRoomTtlMs = 800;
  try {
    const c = new Client(`ws://localhost:${port}`);
    const r = await c.create('game', { name: 'TTL' }, WorldState);
    const rid = r.roomId;
    await r.leave();
    await waitFor(() => ![...GameRoom.instances].some((x) => x.roomId === rid), 5000,
      'empty room disposed after TTL');
  } finally {
    SERVER.match.emptyRoomTtlMs = prevTtl;
  }
}
{
  // Client join-error UX: server rejections must surface their real reason
  // instead of the misleading "cannot reach server" catch-all.
  assert.match(joinErrorMessage({ message: 'too many join attempts — wait a few seconds and try again', code: 526 }),
    /Too many join attempts/, 'rate-limited joins get an actionable message');
  assert.match(joinErrorMessage({ message: 'room "abc" is locked', code: 4214 }),
    /Server rejected the join: room "abc" is locked/, 'other rejections show the server message');
  assert.match(joinErrorMessage({ message: 'timed out loading models — network too slow or unreachable' }),
    /check your connection/, 'load timeouts keep their guidance');
  assert.match(joinErrorMessage(new TypeError('fetch failed')),
    /Cannot reach the server/, 'network failures blame the server address');
}

// Disconnect cleanly (exit=false so the test process survives shutdown).
await gameServer.gracefullyShutdown(false);
// The health suite's fetch() left keep-alive sockets open; force-close them
// so httpServer.close() can complete.
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));

console.log('ok — multiplayer.test.mjs: lifecycle + movement + power-ups + cooldown + reconnect + ghost + attack gate + respawn + win + health verified');
process.exit(0);
