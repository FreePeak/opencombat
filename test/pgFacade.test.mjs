// Facade-over-postgres integration (PRD-postgres-adapter.md AC1/AC2): boots
// persistence.js with PERSISTENCE_DRIVER=postgres set BEFORE import (each
// node --test file is its own process), proving:
//   - preload populates the cache from existing rows before first read
//   - the SYNC read path (loadPlayer) serves preloaded + freshly saved data
//     unchanged — rooms need zero refactors under the SQL backing
//   - debounced saves reach SQL after flushAllAsync
// Skips cleanly without TEST_DATABASE_URL.
// Run: TEST_DATABASE_URL=postgres://... node --test test/pgFacade.test.mjs
if (!process.env.TEST_DATABASE_URL) {
  const { test } = await import('node:test');
  test('pgFacade skipped (TEST_DATABASE_URL not set)', () => {});
  process.exit(0);
}

process.env.PERSISTENCE_DRIVER = 'postgres';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { test } = await import('node:test');
const assert = await import('node:assert/strict');

test('postgres driver: preload -> sync reads -> debounced durable write', async () => {
  // Seed a row through a raw store FIRST so the facade must preload it.
  const { PostgresStore } = await import('../src/server/pgStore.js');
  const raw = new PostgresStore({ connectionString: process.env.DATABASE_URL });
  await raw.init();
  await raw.write('Preloaded', { name: 'Preloaded', score: 7 });

  const persistence = await import('../src/server/persistence.js');
  await persistence.persistenceReady(); // what src/server/index.js awaits

  // Sync read path sees preloaded rows — no awaits anywhere in callers.
  assert.deepEqual(
    persistence.loadPlayer('Preloaded') && { ...persistence.loadPlayer('Preloaded'), _savedAt: undefined },
    { name: 'Preloaded', score: 7, _savedAt: undefined },
  );

  // Save through the facade: visible immediately (overlay/cache), durable
  // only after flush.
  persistence.savePlayerDebounced('FacadeSave', { name: 'FacadeSave', score: 42 });
  assert.equal(persistence.loadPlayer('FacadeSave').score, 42);
  assert.equal((await raw.load('FacadeSave'))?.score ?? null, null,
    'not yet durable before flush (debounce window)');
  await persistence.flushAllAsync();
  assert.equal((await raw.load('FacadeSave')).score, 42, 'flush makes it durable');

  // Hard delete clears overlay + cache + SQL row.
  await persistence.deletePlayerAsync('Preloaded');
  await persistence.deletePlayerAsync('FacadeSave');
  assert.equal(persistence.loadPlayer('Preloaded'), null);
  assert.equal(await raw.load('FacadeSave'), null);

  await raw.close();
});
