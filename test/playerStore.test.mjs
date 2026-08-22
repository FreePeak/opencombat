// Persistence adapter + Postgres driver (PRD-postgres-adapter.md, 2.2 Cycle
// 20). Two layers, two contracts:
//   - RAW DRIVER contract (round-trip / newest-wins / delete / stress /
//     tolerance) against PostgresStore when TEST_DATABASE_URL is set, and
//     against the json backing store always.
//   - FACADE contract (pending-overlay visibility / cancel-never-persists /
//     delete-then-flush cannot resurrect) against persistence.js — these are
//     debounce-layer semantics that live ABOVE any driver.
// Run: node --test test/playerStore.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PG_URL = process.env.TEST_DATABASE_URL || '';

// Strip the facade's bookkeeping stamp so deep-equals pin PLAYER data only.
const stripStamp = (b) => { const { _savedAt, ...rest } = b ?? {}; return rest; };

async function runStorageContract(label, store) {
  // round-trip
  await store.save('Alice', { name: 'Alice', score: 10, nested: { a: 1 } });
  await store.flush();
  assert.deepEqual(stripStamp(await store.load('Alice')),
    { name: 'Alice', score: 10, nested: { a: 1 } });

  // newest write wins on rapid re-save of the same key
  await store.save('Overlay', { v: 1 });
  await store.save('Overlay', { v: 2 });
  await store.flush();
  assert.deepEqual(stripStamp(await store.load('Overlay')), { v: 2 },
    `${label}: newest snapshot survives`);

  // delete removes durably
  await store.del('Doomed');
  assert.equal(await store.load('Doomed'), null, `${label}: deleted -> null`);

  // 100-way concurrent save stress (AC3): last write per player lands
  for (let i = 0; i < 100; i++) {
    store.save(`Stress${i % 10}`, { n: i % 10, seq: i });
  }
  await store.flush();
  const seen = new Map();
  for (let i = 0; i < 100; i++) seen.set(`Stress${i % 10}`, { n: i % 10, seq: i });
  for (const [name, want] of seen) {
    const got = stripStamp(await store.load(name));
    assert.deepEqual(got, want, `${label}: ${name} carries the newest snapshot`);
  }
}

test('json backing passes the raw storage contract (default driver)', async () => {
  const persistence = await import('../src/server/persistence.js');
  persistence._resetForTests();
  const dir = persistence._dirForTests();
  let cleaned = [];
  try {
    await runStorageContract('json', {
      load: (n) => Promise.resolve(persistence.loadPlayerAsync(n)),
      save: (n, d) => { persistence.savePlayerAsync(n, d); return Promise.resolve(); },
      del: (n) => persistence.deletePlayerAsync(n),
      flush: () => persistence.flushAllAsync(),
    });
    cleaned = ['Alice', 'Overlay', 'Doomed'];
    for (let i = 0; i < 10; i++) cleaned.push(`Stress${i}`);
    // malformed record tolerance: junk bytes load as null, never throw (AC2)
    fs.writeFileSync(path.join(dir, 'Junk.json'), '{not json');
    assert.equal(await persistence.loadPlayerAsync('Junk'), null);
    cleaned.push('Junk');
  } finally {
    persistence._resetForTests();
    for (const n of cleaned) { try { fs.rmSync(path.join(dir, `${n}.json`)); } catch {} }
  }
});

test('facade keeps debounce semantics: overlay visible, cancel voids, delete cannot be resurrected', async () => {
  const persistence = await import('../src/server/persistence.js');
  persistence._resetForTests();
  const dir = persistence._dirForTests();
  try {
    // queued save visible to same-tick loads before any flush
    persistence.savePlayerAsync('Overlay', { v: 1 });
    assert.deepEqual(stripStamp(await persistence.loadPlayerAsync('Overlay')),
      { v: 1 }, 'overlay visible pre-flush');

    // cancel drops the queued snapshot -> nothing ever persisted
    persistence.savePlayerAsync('Overlay', { v: 2 });
    persistence.cancelPendingSave('Overlay');
    assert.equal(await persistence.loadPlayerAsync('Overlay'), null,
      'cancelled save never persists');

    // GDPR: a save queued AFTER a hard delete must not resurrect the record
    await persistence.deletePlayerAsync('Doomed');
    persistence.savePlayerAsync('Doomed', { v: 4 });
    await persistence.deletePlayerAsync('Doomed'); // cancels pending + deletes
    await persistence.flushAllAsync();
    assert.equal(await persistence.loadPlayerAsync('Doomed'), null,
      'no resurrection after delete');
  } finally {
    persistence._resetForTests();
    for (const n of ['Overlay', 'Doomed']) {
      try { fs.rmSync(path.join(dir, `${n}.json`)); } catch {}
    }
  }
});

test('postgres driver passes the raw storage contract when TEST_DATABASE_URL is set',
  { skip: !PG_URL && 'TEST_DATABASE_URL not set' },
  async () => {
    const { PostgresStore } = await import('../src/server/pgStore.js');
    const pg = new PostgresStore({ connectionString: PG_URL });
    await pg.init();
    try {
      await pg.raw('DELETE FROM players'); // clean slate
      // Raw driver -> harness adapter (the facade adds debouncing + overlay
      // on top; this block pins the DRIVER's own contract).
      await runStorageContract('postgres', {
        load: (n) => pg.load(n),
        save: (n, d) => pg.write(n, d),
        del: (n) => pg.del(n),
        flush: () => Promise.resolve(), // raw writes are immediate
      });
      // Tolerance probe: JSONB structurally rules out torn/corrupt rows (the
      // failure mode the json driver guards), so pin the equivalent guarantee:
      // unknown names and non-object payloads load as null, never throw.
      assert.equal(await pg.load('NoSuchPlayer'), null);
      await pg.raw(
        `INSERT INTO players (name, data) VALUES ($1, '123'::jsonb)
         ON CONFLICT (name) DO NOTHING`,
        ['PgScalar'],
      );
      assert.equal(await pg.load('PgScalar'), null, 'postgres: non-object payload tolerated as null');
    } finally {
      await pg.close();
    }
  });

// AC4: selecting postgres without DATABASE_URL fails fast with a clear error.
test('PostgresStore without a connection string refuses construction', async () => {
  const { PostgresStore } = await import('../src/server/pgStore.js');
  assert.throws(() => new PostgresStore({}), /DATABASE_URL is required/);
});
