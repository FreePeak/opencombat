// Per-IP token bucket for connection (join) rate limiting — blunt
// join-flooding. Simple in-memory, per process: fine for one instance;
// put a real rate limiter in front for multi-instance deploys.
//
// WHY here and not express middleware: Colyseus 0.17 handles /matchmake*
// with its own router dispatcher that bypasses the express app entirely,
// and a raw http 'request' listener cannot safely short-circuit it (the
// dispatcher would double-respond and crash). The room's onAuth hook is the
// one place with a trustworthy IP (authContext.ip = x-forwarded-for ->
// x-real-ip -> socket.remoteAddress) and a clean rejection path.
import { SERVER } from './config.js';

const buckets = new Map(); // ip -> { tokens, last }
const BUCKET = SERVER.rateLimit;
const IDLE_MS = 5 * 60 * 1000;

/** authContext.ip can be a string or an array (x-forwarded-for list). */
export function normalizeIp(ip) {
  if (Array.isArray(ip)) ip = ip[0];
  return String(ip ?? '').trim() || 'unknown';
}

/** Consume one token; false = rate limited. */
export function takeToken(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: BUCKET.capacity, last: now }; buckets.set(ip, b); }
  b.tokens = Math.min(BUCKET.capacity, b.tokens + (now - b.last) / 1000 * BUCKET.refillPerSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Housekeeping: forget idle buckets so the map cannot grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.last > IDLE_MS) buckets.delete(ip);
}, IDLE_MS).unref();

/** Test hook: forget every bucket (depleted tokens must not leak between
 *  test scenarios that raise/lower the capacity). */
export function resetRateLimit() {
  buckets.clear();
}
