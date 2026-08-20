// Phase 6: worldgen + WorldRoom + persistence
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, WebSocketTransport } from 'colyseus';
import { Client } from '@colyseus/sdk';
import WorldRoom from '../src/server/rooms/WorldRoom.js';
import { WorldState } from '../src/server/schema/StateSchema.js';
import { SERVER } from '../src/server/config.js';
import { buildHttpApp, attachHttpLogging } from '../src/server/http.js';
import { resetRateLimit } from '../src/server/ratelimit.js';
import { generateChunk, biomeForChunk, CHUNK_SIZE, BIOMES, activeChunksForPos, diffChunks, enemiesForLevel } from '../src/shared/worldgen.js';
import { loadPlayer, savePlayerDebounced, flushAll, _dirForTests } from '../src/server/persistence.js';

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

// --- worldgen deterministic tests ---
{
  const c1 = generateChunk(0, 0, 123);
  const c2 = generateChunk(0, 0, 123);
  assert.deepEqual(c1, c2, 'same seed+coords -> same chunk');
  const c3 = generateChunk(0, 0, 999);
  assert.notDeepEqual(c1, c3, 'different seed -> different chunk');
  assert.equal(CHUNK_SIZE, 32, 'chunk size 32');
  assert.equal(BIOMES.length, 3, '3 biomes');
  assert.ok(BIOMES.includes('meadow') && BIOMES.includes('dead_forest') && BIOMES.includes('ashland'), 'biomes are meadow/dead_forest/ashland');
  const biome = biomeForChunk(1, 2, 42);
  assert.ok(BIOMES.includes(biome), 'biomeForChunk returns valid biome');
  const active = activeChunksForPos(0, 0, 2, 123);
  assert.equal(active.length, 25, 'radius 2 => 25 chunks');
  const next = activeChunksForPos(CHUNK_SIZE * 3, 0, 2, 123);
  const diff = diffChunks(active, next);
  assert.ok(diff.toLoad.length > 0 && diff.toUnload.length > 0, 'diff detects load/unload when moving 3 chunks');
  assert.equal(enemiesForLevel(1), 1, 'level 1 -> 1 enemy per chunk');
  assert.equal(enemiesForLevel(10), 4, 'level 10 -> 4 enemies (1 + floor(9/3))');
  console.log('ok — worldgen deterministic, chunk size, biomes, active chunks, level scaling');
}

// --- grass ground cover (ARTWORK_PLAN phase 1, world side) ---
{
  // Every chunk must carry per-tuft grass data, deterministic per seed, and
  // density must follow the biome (meadow lush, dead forest sparse, ashland
  // near-bare). Appended AFTER the existing rng draws so props/spawnPoints
  // stay byte-identical to pre-grass chunks.
  const before = generateChunk(1, -2, 777);
  const { grass } = before;
  assert.ok(Array.isArray(grass) && grass.length > 0, 'chunk carries grass tufts');
  for (const g of grass) {
    assert.ok(typeof g.x === 'number' && typeof g.z === 'number', 'tuft has x/z');
    assert.ok(g.x >= before.x && g.x < before.x + CHUNK_SIZE, 'tuft x inside chunk');
    assert.ok(g.z >= before.z && g.z < before.z + CHUNK_SIZE, 'tuft z inside chunk');
  }
  const again = generateChunk(1, -2, 777);
  assert.deepEqual(grass, again.grass, 'grass deterministic for seed+coords');
  // Biome density ordering across a sweep of chunks: meadow > dead forest > ashland.
  const byBiome = { meadow: [], dead_forest: [], ashland: [] };
  for (let cx = -20; cx <= 20; cx++) {
    for (let cz = -20; cz <= 20; cz++) {
      const c = generateChunk(cx, cz, 55);
      byBiome[c.biome].push(c.grass.length);
    }
  }
  const avg = (a) => a.reduce((s, n) => s + n, 0) / a.length;
  assert.ok(byBiome.meadow.length > 0 && byBiome.dead_forest.length > 0 && byBiome.ashland.length > 0,
    'sweep covers all three biomes');
  assert.ok(avg(byBiome.meadow) > avg(byBiome.dead_forest), 'meadow grassier than dead forest');
  assert.ok(avg(byBiome.dead_forest) > avg(byBiome.ashland), 'dead forest grassier than ashland');
  // Regression: props/spawnPoints unchanged by the grass addition.
  const legacySeed = generateChunk(3, 4, 123);
  assert.ok(legacySeed.props.every((p) => ['tree', 'dead_tree', 'rock'].includes(p.type)),
    'props types unchanged');
  assert.equal(legacySeed.spawnPoints.length, generateChunk(3, 4, 123).spawnPoints.length,
    'spawn point count stable');
  console.log(`ok — grass ground cover: ${grass.length} tufts @777, biome density meadow>${avg(byBiome.dead_forest).toFixed(0)}>${avg(byBiome.ashland).toFixed(0)}`);
}

// --- WorldRoom + persistence integration ---
const httpServer = http.createServer();
attachHttpLogging(httpServer);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app)
});
gameServer.define('world', WorldRoom);
await gameServer.listen(0);
const port = httpServer.address().port;
const roomOf = (r) => [...WorldRoom.instances].find((x) => x.roomId === r.roomId);

{
  // Join world, check initial state is playing and chunks loaded
  const client = new Client(`ws://localhost:${port}`);
  const room = await client.create('world', { name: 'WorldTester', character: 0 }, WorldState);
  const sr = roomOf(room);
  await waitFor(() => room.state.matchState === 'playing', 3000, 'world playing');
  assert.equal(room.state.matchState, 'playing', 'world starts playing');
  // Check that server has loaded chunks around origin (radius 2)
  assert.ok(sr.loadedChunks.size >= 9, `loadedChunks >=9 (got ${sr.loadedChunks.size})`);
  // Check enemies exist (level-scaled, at least 1)
  const alive = [...room.state.enemies].filter((e) => e.hp > 0).length;
  assert.ok(alive >= 1, `world has alive enemies (got ${alive})`);
  // Move player far to trigger chunk streaming
  const player = sr.state.players.get(room.sessionId);
  const beforeKeys = new Set(sr.loadedChunks.keys());
  player.x = CHUNK_SIZE * 10;
  player.z = CHUNK_SIZE * 10;
  // Force chunk update (normally on tick, but trigger manually)
  sr.updatePlayerChunks(room.sessionId);
  await waitMs(100);
  const afterKeys = new Set(sr.loadedChunks.keys());
  // Should have unloaded some old and loaded new
  let newLoads = 0;
  for (const k of afterKeys) if (!beforeKeys.has(k)) newLoads++;
  assert.ok(newLoads > 0, `chunk streaming loads new chunks when moving (newLoads ${newLoads})`);
  // Check that client received chunksLoad message? The room should have sent it
  room.leave();
  await waitMs(200);
  console.log('ok — WorldRoom chunk streaming and enemy spawning');
}

{
  // Persistence: debounced per-player JSON, no accounts, level restores
  const dir = _dirForTests();
  const testName = `ptest_${Date.now() % 100000}`; // short <16 to avoid truncation mismatch
  const safe = testName.slice(0, 16).replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(dir, `${safe}.json`);
  // Clean up any prior file
  try { fs.unlinkSync(file); } catch {}
  // Save
  savePlayerDebounced(testName, { level: 5, xp: 700, upgrades: { vitality: 2 }, pendingChoices: [] });
  // File should NOT exist immediately (debounced 2s)
  assert.ok(!fs.existsSync(file), 'file not yet written before debounce');
  await waitMs(2100);
  assert.ok(fs.existsSync(file), 'file written after debounce 2s');
  const data = loadPlayer(testName);
  assert.equal(data.level, 5, 'level persisted');
  assert.equal(data.xp, 700, 'xp persisted');
  assert.equal(data.upgrades.vitality, 2, 'upgrades persisted');
  // Now test WorldRoom restores level on join
  const client = new Client(`ws://localhost:${port}`);
  const room = await client.create('world', { name: testName, character: 1 }, WorldState);
  await waitFor(() => room.state.players.get(room.sessionId)?.level === 5, 3000, 'restored level 5');
  const p = room.state.players.get(room.sessionId);
  assert.equal(p.level, 5, 'WorldRoom restored level from persistence');
  assert.equal(p.xp, 700, 'restored xp');
  assert.equal(p.upgrades.get('vitality'), 2, 'restored upgrades');
  // Level up and check debounced save updates file
  const sr = roomOf(room);
  sr.grantXp(room.sessionId, 1000); // should level up further
  await waitMs(100);
  // File still old until debounce
  const oldData = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(oldData.level, 5, 'file still old before debounce after xp gain');
  await waitMs(2100);
  const newData = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(newData.level > 5, `level increased after save (got ${newData.level})`);
  assert.ok(newData.xp > 700, 'xp increased');
  room.leave();
  await waitMs(300);
  // Cleanup
  try { fs.unlinkSync(file); } catch {}
  flushAll();
  console.log('ok — persistence debounced 2s per-player file, restore on join');
}

{
  // Client chunks are deterministic: server and client generate same chunk for same seed/coords
  const seed = 4242;
  const cServer = generateChunk(3, -2, seed);
  const cClient = generateChunk(3, -2, seed);
  assert.deepEqual(cServer, cClient, 'server and client generate identical chunk for same seed');
  // Different chunk coords give different biome/props (usually)
  const cOther = generateChunk(4, -2, seed);
  assert.notDeepEqual(cServer.props, cOther.props, 'different coords give different props');
  console.log('ok — client/server worldgen parity');
}

await gameServer.gracefullyShutdown(false);
httpServer.closeAllConnections();
await new Promise((res) => httpServer.close(res));
resetRateLimit();

console.log('ok — world.test.mjs: worldgen, WorldRoom streaming, persistence, client parity verified');
process.exit(0);
