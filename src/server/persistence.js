// Per-player persistence facade (PRD-postgres-adapter.md, 2.2 Cycle 20).
// Default driver: per-player JSON files — `data/players/<name>.json`,
// debounced 2s, byte-identical to the pre-adapter behavior every existing
// suite pins. PERSISTENCE_DRIVER=postgres swaps the backing store: rows live
// in a `players` table (src/server/pgStore.js), PRELOADED into memory at
// boot so the rooms' synchronous read path is unchanged (finalizes run
// inside the fixed-timestep step and must never await), while writes stay
// debounced and flush to SQL. Locked decision: per-player-name identity,
// no accounts. Sanitized name is the filename/key.
//
// Async API (loadPlayerAsync/savePlayerAsync/deletePlayerAsync/flushAllAsync)
// is the forward-looking seam; under both drivers it resolves against the
// same overlay + cache the sync API reads.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER } from './config.js';
import { log, warn } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const dir = path.resolve(root, SERVER.persistence?.dir || 'data/players');
const debounceMs = SERVER.persistence?.debounceMs ?? 2000;
const DRIVER = SERVER.persistence?.driver || 'json';
const DATABASE_URL = SERVER.persistence?.databaseUrl || '';

// Ensure directory exists at module load
try {
  fs.mkdirSync(dir, { recursive: true });
} catch {}

function safeName(raw) {
  // Must match PlayerState name sanitization (trim, 16 cap) plus filesystem safety.
  // Server's sanitizeName is `trim().slice(0,16)`; we mirror that then sanitize for FS.
  const n = String(raw ?? '').trim().slice(0, 16).replace(/[^a-zA-Z0-9_-]/g, '_');
  return n || 'player';
}

function fileFor(name) {
  return path.join(dir, `${safeName(name)}.json`);
}

// --- Postgres driver plumbing -----------------------------------------------
// pgCache holds the committed snapshot per key; `pending` overlays it with the
// newest queued save. Boot preload keeps the sync read path authoritative.
const pgCache = new Map();
let pgStore = null;
let pgReady = null;

/** Connect + migrate + preload. Idempotent; shared promise for concurrency. */
export function persistenceReady() {
  if (DRIVER !== 'postgres') return Promise.resolve();
  if (!pgReady) {
    pgReady = (async () => {
      const { PostgresStore } = await import('./pgStore.js');
      pgStore = new PostgresStore({ connectionString: DATABASE_URL });
      await pgStore.init();
      for (const key of await pgStore.keys()) {
        const blob = await pgStore.load(key);
        if (blob) pgCache.set(key, blob);
      }
      log('persistence_pg_ready', { players: pgCache.size });
    })();
    pgReady.catch((err) => {
      // Fail fast + loud (AC4): a misconfigured driver must not silently
      // degrade into an empty store.
      warn('persistence_pg_init_failed', { error: err?.message });
    });
  }
  return pgReady;
}
if (DRIVER === 'postgres') persistenceReady(); // kick off at module load

async function persistToDb(key, snap) {
  try {
    await persistenceReady();
    await pgStore.write(key, snap);
  } catch (err) {
    warn('persistence_save_failed', { name: key, error: err?.message });
  }
}

// In-memory timers for debounce: name -> timeout
const timers = new Map();
// Pending in-memory snapshots waiting to flush: name -> data
const pending = new Map();

/** Load persisted data for `name` if it exists, else null.
 *  PENDING OVERLAY (PRD-career-stats.md): a queued debounced save is
 *  visible to subsequent loads in the same tick — two back-to-back
 *  read-merge-save cycles (career inside endMatch, daily blob right after)
 *  must not clobber each other. Newest wins per key; backing-store data
 *  survives under keys the pending snapshot doesn't carry. */
export function loadPlayer(name) {
  const key = safeName(name);
  let data = null;
  if (DRIVER === 'postgres') {
    data = pgCache.get(key) ?? null;
  } else {
    const file = fileFor(key);
    try {
      if (fs.existsSync(file)) {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch (err) {
      warn('persistence_load_failed', { name, error: err?.message });
      data = null;
    }
  }
  const snap = pending.get(key);
  if (snap) data = { ...(data ?? {}), ...snap };
  return data;
}

/** Queue a debounced save for `name` with snapshot `data` (level/xp/upgrades etc). */
export function savePlayerDebounced(name, data) {
  const key = safeName(name);
  pending.set(key, { ...data, _savedAt: Date.now() });
  if (DRIVER === 'postgres') {
    // Write-through cache: once the overlay drains at flush time the cache
    // must already carry this snapshot or reads would regress pre-flush.
    pgCache.set(key, pending.get(key));
  }
  if (timers.has(key)) clearTimeout(timers.get(key));
  const t = setTimeout(() => {
    timers.delete(key);
    const snap = pending.get(key);
    if (!snap) return;
    pending.delete(key);
    if (DRIVER === 'postgres') {
      void persistToDb(key, snap); // durable write follows the cache update
      return;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = fileFor(key);
      // Write atomically via temp + rename to avoid torn reads
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      log('persistence_save', { name: key, file: path.relative(root, file) });
    } catch (err) {
      warn('persistence_save_failed', { name: key, error: err?.message });
    }
  }, debounceMs);
  // Allow process to exit without waiting for timer
  if (t.unref) t.unref();
  timers.set(key, t);
}

/** Drop any queued debounced save for `name` (admin/GDPR delete support):
 *  clears its timer + pending snapshot so a deleted player cannot be
 *  resurrected by an in-flight flush. */
export function cancelPendingSave(name) {
  const key = safeName(name);
  const t = timers.get(key);
  if (t) clearTimeout(t);
  timers.delete(key);
  pending.delete(key);
}

/** Immediate flush for shutdown/tests (json driver: synchronous). */
export function flushAll() {
  for (const [key, t] of timers) {
    clearTimeout(t);
  }
  timers.clear();
  for (const [key, snap] of pending) {
    try {
      if (DRIVER === 'postgres') {
        pgCache.set(key, snap); // cache-first; DB write rides flushAllAsync
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      const file = fileFor(key);
      fs.writeFileSync(file, JSON.stringify(snap, null, 2), 'utf8');
    } catch {}
  }
  pending.clear();
}

/** Await every queued write's durable flush (shutdown/tests, both drivers). */
export async function flushAllAsync() {
  if (DRIVER === 'postgres') {
    const snaps = [...pending.entries()];
    for (const [key, snap] of snaps) pgCache.set(key, snap);
    pending.clear();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    await persistenceReady();
    for (const [key, snap] of snaps) await persistToDb(key, snap);
    return;
  }
  flushAll();
}

/** Hard delete across overlay, cache and backing store (GDPR contract). */
export async function deletePlayerAsync(name) {
  const key = safeName(name);
  cancelPendingSave(name);
  if (DRIVER === 'postgres') {
    pgCache.delete(key);
    await persistenceReady();
    try { await pgStore.del(key); } catch (err) {
      warn('persistence_delete_failed', { name: key, error: err?.message });
    }
    return;
  }
  try { fs.rmSync(fileFor(key)); } catch {}
}

// --- Async seam (same semantics as the sync API, awaitable signatures) ------
export async function loadPlayerAsync(name) {
  return loadPlayer(name);
}
export function savePlayerAsync(name, data) {
  savePlayerDebounced(name, data);
}

/** For tests: clear debounce state without touching files. */
export function _resetForTests() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  pending.clear();
}

export function _dirForTests() {
  return dir;
}
