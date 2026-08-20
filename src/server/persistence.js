// Simple per-player JSON persistence — `data/players/<name>.json`, debounced 2s.
// Locked decision: per-player-name files, no accounts. Sanitized name is the filename.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER } from './config.js';
import { log, warn } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const dir = path.resolve(root, SERVER.persistence?.dir || 'data/players');
const debounceMs = SERVER.persistence?.debounceMs ?? 2000;

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

// In-memory timers for debounce: name -> timeout
const timers = new Map();
// Pending in-memory snapshots waiting to flush: name -> data
const pending = new Map();

/** Load persisted data for `name` if it exists, else null. */
export function loadPlayer(name) {
  const file = fileFor(name);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return data;
  } catch (err) {
    warn('persistence_load_failed', { name, error: err?.message });
    return null;
  }
}

/** Queue a debounced save for `name` with snapshot `data` (level/xp/upgrades etc). */
export function savePlayerDebounced(name, data) {
  const key = safeName(name);
  pending.set(key, { ...data, _savedAt: Date.now() });
  if (timers.has(key)) clearTimeout(timers.get(key));
  const t = setTimeout(() => {
    timers.delete(key);
    const snap = pending.get(key);
    if (!snap) return;
    pending.delete(key);
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

/** Immediate flush for shutdown/tests. */
export function flushAll() {
  for (const [key, t] of timers) {
    clearTimeout(t);
  }
  timers.clear();
  for (const [key, snap] of pending) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = fileFor(key);
      fs.writeFileSync(file, JSON.stringify(snap, null, 2), 'utf8');
    } catch {}
  }
  pending.clear();
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
