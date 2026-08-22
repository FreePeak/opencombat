// PostgresStore (PRD-postgres-adapter.md, 2.2 Cycle 20): the Postgres driver
// behind the persistence facade. One table, idempotent DDL, upsert writes.
// `pg` is imported lazily so the default json deployment never loads it
// (AC4: json default never imports pg).
//
// Consumers:
//   src/server/persistence.js -> active driver when PERSISTENCE_DRIVER=postgres
//   test/playerStore.test.mjs -> shared contract harness

const DDL = `
  CREATE TABLE IF NOT EXISTS players (
    name TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

export class PostgresStore {
  /** @param {string} connectionString e.g. postgres://user@host:port/db */
  constructor({ connectionString } = {}) {
    if (!connectionString) {
      throw new Error(
        'PostgresStore: DATABASE_URL is required when PERSISTENCE_DRIVER=postgres'
      );
    }
    this.connectionString = connectionString;
    this.pool = null;
  }

  /** Connect + run the idempotent migration. Fail-fast surface for boot. */
  async init() {
    const pg = await import('pg');
    this.pool = new pg.Pool({ connectionString: this.connectionString });
    await this.pool.query(DDL);
    return this;
  }

  /** Blob by exact key, or null. Non-object payloads (JSON scalars) read as null. */
  async load(name) {
    const r = await this.pool.query('SELECT data FROM players WHERE name = $1', [name]);
    const d = r.rows[0]?.data;
    return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
  }

  /** Upsert the newest snapshot for `name`. */
  async write(name, data) {
    await this.pool.query(
      `INSERT INTO players (name, data) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [name, JSON.stringify(data)]
    );
  }

  /** Hard delete (GDPR support). Returns true when a row was removed. */
  async del(name) {
    const r = await this.pool.query('DELETE FROM players WHERE name = $1', [name]);
    return (r.rowCount ?? 0) > 0;
  }

  /** All keys (boot preload / inventory scans). */
  async keys() {
    const r = await this.pool.query('SELECT name FROM players ORDER BY name');
    return r.rows.map((row) => row.name);
  }

  /** Test/admin escape hatch. */
  async raw(query, params) {
    return this.pool.query(query, params);
  }

  async close() {
    await this.pool?.end();
    this.pool = null;
  }
}
