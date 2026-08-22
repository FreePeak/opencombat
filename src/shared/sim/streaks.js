// Kill-streak tracking (P2.7): pure module shared by GameRoom + LocalRoom so
// online and offline modes produce IDENTICAL streak payloads (structural
// parity — no duplicated logic). A streak is consecutive kills attributed to
// one player inside a rolling window; only MILESTONE counts are surfaced so
// announcements stay special.
//
// Room contract:
//   - on every enemy death credited to player sid:
//       const ms = registerKill(this.streaks, sid, now);
//       if (ms) broadcast/emit('killStreak', { sid, name, count, label: ms });
//   - on player death / match reset: resetSid(this.streaks, sid) or resetAll

export const STREAK_WINDOW_MS = 2500;

// count -> announcement label. Milestones ONLY; everything else stays silent.
export const MILESTONES = [
  { count: 3, label: 'Killing Spree' },
  { count: 5, label: 'Rampage' },
  { count: 10, label: 'Dominating' },
  { count: 15, label: 'Unstoppable' },
  { count: 25, label: 'Godlike' },
];

export function newStreakState() {
  return new Map(); // sid -> { count, lastAt }
}

export function milestoneFor(count) {
  const hit = MILESTONES.find(m => m.count === count);
  return hit ? hit.label : null;
}

// Registers a kill for sid at time `now` (ms). Returns the milestone label if
// this kill IS a milestone, else null. A kill after the window lapses restarts
// the counter at 1 (never announces by itself — 1 is not a milestone).
export function registerKill(state, sid, now) {
  let entry = state.get(sid);
  if (!entry || now - entry.lastAt > STREAK_WINDOW_MS) {
    entry = { count: 0, lastAt: now };
  }
  entry.count += 1;
  entry.lastAt = now;
  state.set(sid, entry);
  return milestoneFor(entry.count);
}

// Death/reset hook: drop the streak silently.
export function resetSid(state, sid) {
  state.delete(sid);
}

export function resetAll(state) {
  state.clear();
}
