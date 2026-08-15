// Join-failure → user-facing message. Kept dependency-free so Node tests can
// import it directly (network.js touches the browser-only `Colyseus` global).
//
// Server rejections (per-IP rate limit, room full/locked, auth) surface their
// REAL reason; only a genuine network-level failure blames the server address.
// The per-IP rate limiter refills ~1 token per 2s, so the guidance tells the
// user how long to wait instead of leaving them to guess.
export function joinErrorMessage(err) {
  const msg = (err && err.message) || '';
  if (msg.includes('timed out')) return `${msg} — check your connection and retry.`;
  if (msg.includes('too many join attempts')) {
    return 'Too many join attempts from this address — wait about 20 seconds, then try again.';
  }
  if (typeof err?.code === 'number' && err.code > 0) {
    // Server-side rejection with a real message (room locked/full, auth, ...).
    return `Server rejected the join: ${msg}`;
  }
  return 'Cannot reach the server — make sure it is running on this host and port (npm run serve).';
}
