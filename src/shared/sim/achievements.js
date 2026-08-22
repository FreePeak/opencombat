// Achievements (P2.12): pure predicate engine over the persisted player blob
// (career/daily/weekly records already written by finalize paths). Evaluating
// never mutates its input; callers merge `unlocked` into the player file and
// broadcast only `newIds` so clients toast once per batch.
//
// Room contract:
//   const { unlocked, newIds } = evaluateAchievements(saved);
//   if (newIds.length) { saved.achievements = unlocked; save; broadcast(...) }

export const ACHIEVEMENTS = [
  { id: 'first_run',  name: 'First Steps',    test: s => num(s?.career?.runs) >= 1 },
  { id: 'veteran',    name: 'Veteran',        test: s => num(s?.career?.runs) >= 10 },
  { id: 'centurion',  name: 'Centurion',      test: s => num(s?.career?.runs) >= 50 },
  { id: 'first_win',  name: 'First Blood',    test: s => num(s?.career?.victories) >= 1 },
  { id: 'wave_5',     name: 'Ridge Runner',   test: s => num(s?.career?.bestWave) >= 5 },
  { id: 'wave_9',     name: 'Ashwalker',      test: s => num(s?.career?.bestWave) >= 9 },
  { id: 'wave_12',    name: "Warlord's End",  test: s => num(s?.career?.bestWave) >= 12 },
  { id: 'score_2k',   name: 'Score Hunter',   test: s => num(s?.career?.bestScore) >= 2000 },
  { id: 'daily_3',    name: 'Committed',      test: s => num(s?.daily?.streak) >= 3 },
  { id: 'weekly_1500', name: 'Weekly Warrior', test: s => num(s?.weekly?.bestScore) >= 1500 },
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : -Infinity;
}

const byId = new Map(ACHIEVEMENTS.map(a => [a.id, a]));

export function achievementById(id) {
  return byId.get(id) ?? null;
}

// Returns { unlocked, newIds }: every satisfied id (stable table order), and
// just the subset not already present in saved.achievements.
export function evaluateAchievements(saved) {
  const have = new Set(
    Array.isArray(saved?.achievements) ? saved.achievements : []
  );
  const unlocked = [];
  const newIds = [];
  for (const a of ACHIEVEMENTS) {
    if (!a.test(saved)) continue;
    unlocked.push(a.id);
    if (!have.has(a.id)) newIds.push(a.id);
  }
  return { unlocked, newIds };
}
