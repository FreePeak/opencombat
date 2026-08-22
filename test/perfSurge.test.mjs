// PERF GATE (research lesson #6, roadmap-Q3 spirit): worst-case waves tick —
// full-pool finale surge with a boss + shooters firing + burns/volatiles
// armed — must process well inside the 50ms tick budget. Generous budgets on
// purpose: this gate catches PATHOLOGICAL regressions (O(n^2) walks, per-tick
// allocations gone wild), not jitter. Run: node --test test/perfSurge.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import GameRoom from '../src/server/rooms/GameRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import { SHOOTER_PREFERRED_RANGE } from '../src/shared/sim/archetypes.js';

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

// finale-wave worst case: p95 tick < 25ms, max < 45ms over a 6s soak
{
  const prevFinale = SERVER.wave.finaleWave;
  SERVER.wave.finaleWave = 12; // the real finale: boss + full pool + shooters
  try {
    const c = new Client(`ws://localhost:${port}`);
    const r = await c.create('game', { name: 'Perf' }, WorldState);
    const sr = roomOf(r);
    await waitFor(() => sr.state.matchState === 'playing', 8000, 'match playing');

    // Drive internals straight to the worst case: boss wave live, every slot
    // active, players scattered so shooters/chasers all have targets.
    sr.spawnWave(12);
    const players = [...sr.state.players.values()];
    players.forEach((p, i) => {
      p.x = (i - players.length / 2) * 4;
      p.z = i % 2 === 0 ? 8 : -8;
    });
    // Keep everyone topped up mid-soak (deaths would flip intermission).
    const topUp = setInterval(() => {
      for (const p of players) if (p.hp > 0) p.hp = Math.max(p.hp, 50);
    }, 1000);

    // Soak 6s of real ticks; sample the room's own lastTickMs instrumentation.
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      samples.push(GameRoom.stats.lastTickMs);
      await waitMs(20);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    const max = samples[samples.length - 1];
    const median = samples[Math.floor(samples.length / 2)];
    console.log(`perf: median=${median.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms n=${samples.length}`);

    assert.ok(median < 10, `median tick ${median.toFixed(2)}ms < 10ms`);
    assert.ok(p95 < 25, `p95 tick ${p95.toFixed(2)}ms < 25ms (half budget)`);
    assert.ok(max < 45, `max tick ${max.toFixed(2)}ms < 45ms (under ${SERVER.tickMs}ms)`);
    clearInterval(topUp);
    r.leave();
  } finally {
    SERVER.wave.finaleWave = prevFinale;
  }
}
console.log('ok — perfSurge.test.mjs: worst-case finale tick budget respected');

await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
process.exit(0);
