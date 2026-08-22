# PRD: Persistence adapter + Postgres driver (2.2, Cycle 20)

Status: PLANNED (cycle 20) — last open Q2 roadmap row.
Unblocked this session: Homebrew Postgres available locally; docker not
required. CI gains a postgres service container so the driver is exercised
on every push, not just locally.

## Problem

Player persistence is hardwired to per-name JSON files
(`src/server/persistence.js`). The tracker's 2.2 row calls for a PlayerStore
abstraction with JsonFileStore preserved as default and a PostgresStore
behind config — required before multi-process deployments and richer
queries (leaderboard scans are full-directory reads today).

## Solution

- Keep `persistence.js` as the module facade with identical exports and
  byte-identical JSON-driver behavior (all existing suites must pass
  unmodified).
- Add an async store seam: `loadPlayerAsync`, `savePlayerAsync` (debounced,
  same pending-overlay semantics), `deletePlayerAsync`, `flushAllAsync`.
  The debounce/pending layer is driver-agnostic and stays in persistence.js.
- `src/server/pgStore.js`: PostgresStore — lazy `import('pg')`, boot-time
  migration `CREATE TABLE IF NOT EXISTS players(name TEXT PRIMARY KEY,
  data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`,
  load = SELECT, save = upsert ON CONFLICT, delete = DELETE. Selected via
  `SERVER.persistence.driver === 'postgres'` (+ `DATABASE_URL`).
- Convert the ~8 sync call sites (GameRoom finalize x3, WorldRoom, http admin
  export/delete, oidc binding) to the awaited variants.
- CI: postgres service on the verify job exporting TEST_DATABASE_URL;
  driver contract tests skip cleanly when unset.

## Scope

- New: src/server/pgStore.js, test/playerStore.test.mjs (contract harness
  run against BOTH drivers), PRD, CI service wiring, package.json `pg` dep.
- Modified: persistence.js (seam + delegation, zero behavior change for
  json), the call sites above, README/ARCHITECTURE persistence notes.

## Out of scope

- Session/state stores (presence stays RedisPresence/in-memory).
- Read replicas, migrations tooling beyond the single idempotent DDL.
- Changing any persisted blob shape.

## Acceptance criteria

1. Default boot (`driver` unset): byte-identical behavior — entire existing
   suite green without modification.
2. Contract harness passes identically on json and postgres: round-trip,
   pending overlay visibility, cancel-pending durability, malformed-record
   tolerance, delete-then-flush cannot resurrect.
3. 100-way concurrent debounced save stress lands exactly the newest
   snapshot per player on both drivers.
4. With no DATABASE_URL, selecting postgres fails fast at boot with a clear
   error; json default never imports pg.
5. Full gate green locally AND in hosted CI including the postgres-backed
   contract tests.
