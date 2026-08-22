// Weekly Gauntlet (P2.11): ISO-week-seeded challenge runs that reuse the
// Daily Gauntlet pipeline. Differences from daily: seed source is the ISO
// week key, modifiers STACK 3 distinct daily-table rows multiplicatively
// ("boss week" feel), and persistence deliberately has NO streak — a weekly
// is about bestScore ambition, not daily guilt (research: forgiveness wins).
//
// Consumers:
//   GameRoom mode==='weekly' -> this.dailyMods becomes weeklyModifiers(weekKey)
//   http /api/weekly         -> { week, seed, modifiers, rewards, leaderboard }
//   persistence finalize     -> player.weekly = { week, bestScore, lastPlayed }

import { ELITE_AFFIXES } from './elites.js';

export function utcWeekKey(now = Date.now()) {
  const d = new Date(now);
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = new Date(utc).getUTCDay() || 7; // Mon=1..Sun=7
  // Thursday of this ISO week decides the year.
  const thursday = new Date(utc + (4 - day) * 86400000);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function weeklySeed(weekKey) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < weekKey.length; i++) {
    h ^= weekKey.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h | 1;
}

// Deterministically pick 3 DISTINCT daily rows and compose them. Values grow
// vs any single row so a weekly always reads harder than its ingredients.
export function weeklyModifiers(weekKeyOrSeed) {
  const seed =
    typeof weekKeyOrSeed === 'number'
      ? weekKeyOrSeed | 0
      : weeklySeed(String(weekKeyOrSeed));
  const pool = [...ELITE_AFFIXES];
  const picked = [];
  let s = seed >>> 0;
  while (picked.length < 3 && pool.length > 0) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    picked.push(pool.splice(s % pool.length, 1)[0]);
  }
  const round2 = v => Math.round(v * 100) / 100;
  return {
    label: picked.map(p => p.name).join(' + '),
    description: `Weekly stack: ${picked.map(p => p.name).join(', ')}.`,
    enemyHpMul: round2(picked.reduce((a, p) => a * p.hpMul, 1)),
    enemySpeedMul: round2(Math.min(2, picked.reduce((a, p) => a * p.speedMul, 1))),
    enemyCountBonus: picked.length, // +1 slot per stacked row, deterministic
    stack: picked.map(p => p.name)
  };
}

// Flat XP ladder by score thresholds — monotonic, no streak dependency.
const LADDER = [0, 500, 1500, 3000, 5000];
export function weeklyRewardXp(bestScore) {
  let tier = 0;
  for (let i = 0; i < LADDER.length; i++) {
    if (bestScore >= LADDER[i]) tier = i;
  }
  return (tier + 1) * 150;
}

// Merge rule for finalize: same-week keeps the max, new week replaces.
export function mergeWeekly(prev, weekKey, score) {
  if (prev && prev.week === weekKey) {
    return { week: weekKey, bestScore: Math.max(prev.bestScore ?? 0, score), lastPlayed: weekKey };
  }
  return { week: weekKey, bestScore: score, lastPlayed: weekKey };
}

// Objective table (ADDENDUM Cycle 17): each week deterministically selects 2
// DISTINCT entries, checked at every weekly finalize against the run's
// {wave, score}. Boundaries are inclusive (>=).
export const WEEKLY_OBJECTIVES = [
  { id: 'wave_6', description: 'Reach wave 6', kind: 'wave', value: 6, test: r => r.wave >= 6 },
  { id: 'wave_10', description: 'Reach wave 10', kind: 'wave', value: 10, test: r => r.wave >= 10 },
  { id: 'score_800', description: 'Score 800 in one run', kind: 'score', value: 800, test: r => r.score >= 800 },
  { id: 'score_2000', description: 'Score 2000 in one run', kind: 'score', value: 2000, test: r => r.score >= 2000 },
];

// Pick this week's 2 distinct objectives via the same LCG weeklyModifiers
// uses on ELITE_AFFIXES — splice from a copy so the shared table is never
// mutated across calls.
export function weeklyObjectives(weekKeyOrSeed) {
  const seed =
    typeof weekKeyOrSeed === 'number'
      ? weekKeyOrSeed | 0
      : weeklySeed(String(weekKeyOrSeed));
  const pool = [...WEEKLY_OBJECTIVES];
  const picked = [];
  let s = seed >>> 0;
  while (picked.length < 2 && pool.length > 0) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    picked.push(pool.splice(s % pool.length, 1)[0]);
  }
  return picked;
}

// Evaluate a run against the week's objectives -> [{id, done}]. Pure; the
// sticky "done once true" merge happens at finalize, not here.
export function evaluateWeeklyRun(objectives, run) {
  return objectives.map(o => ({ id: o.id, done: !!o.test(run) }));
}

// Sticky-merge objective results into a persisted record: same-week keeps
// done once true per id; a new week replaces wholesale.
export function mergeWeeklyObjectives(prev, weekKey, results) {
  if (!prev || prev.week !== weekKey) {
    return { week: weekKey, objectives: results.map(r => ({ ...r })) };
  }
  const prior = new Map((prev.objectives ?? []).map(o => [o.id, o.done]));
  return {
    week: weekKey,
    objectives: results.map(r => ({ id: r.id, done: prior.get(r.id) === true || r.done })),
  };
}
