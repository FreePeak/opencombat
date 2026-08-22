// Presence registry (P2.8): server-side singleton tracking every connected
// player across ALL room types (game/waves, world, lobby, arena) so the
// /api/players endpoint and the client "online now" panel can show a live
// population. Map-backed; indie scale makes O(n) scans fine.
//
// Room contract (2-line hooks):
//   onJoin  -> registerPresence(client.sessionId, { name, mode: 'waves', roomId: this.roomId })
//   onLeave -> removePresence(client.sessionId)
//   redirect/queue transitions -> updateMode(sid, mode)

const registry = new Map(); // sid -> { name, mode, roomId, at }

export function registerPresence(sid, { name, mode = 'idle', roomId = null } = {}) {
  if (!sid) return null;
  const entry = {
    name: String(name ?? 'anon'),
    mode,
    roomId,
    at: Date.now()
  };
  registry.set(sid, entry); // upsert — re-join never duplicates
  return entry;
}

export function updateMode(sid, mode) {
  const entry = registry.get(sid);
  if (entry) entry.mode = mode;
  return entry ?? null;
}

export function removePresence(sid) {
  return registry.delete(sid);
}

// Sorted by join time (oldest first) for stable UI ordering.
export function listPresence() {
  return [...registry.entries()]
    .sort((a, b) => a[1].at - b[1].at)
    .map(([sid, e]) => ({ sid, name: e.name, mode: e.mode, roomId: e.roomId }));
}

export function presenceCount() {
  return registry.size;
}

export function _resetForTests() {
  registry.clear();
}
