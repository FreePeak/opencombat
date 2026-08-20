// Shared arena helpers — pure functions used by both ArenaRoom (server)
// and LobbyRoom + client (mode validation, team assignment, win checks).
// No side effects; same inputs -> same outcomes everywhere.

import { SERVER } from '../server/config.js';

export const ARENA_MODES = ['duel', 'team', 'ffa'];
export const DEFAULT_MODE = 'ffa';
export const DEFAULT_ROUNDS_TO_WIN = 2;
export const DEFAULT_PVE = false;

/** True when mode is one of the known arena modes. */
export function isValidMode(mode) {
  return ARENA_MODES.includes(mode);
}

/** Sanitize a raw mode string from join options / queue message. */
export function sanitizeMode(raw) {
  const m = String(raw ?? '').trim().toLowerCase();
  return isValidMode(m) ? m : DEFAULT_MODE;
}

/** Sanitize PvE toggle (truthy string/bool). */
export function sanitizePve(raw) {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
  return !!raw;
}

/** Sanitize roundsToWin: integer clamped to 1..5. */
export function sanitizeRoundsToWin(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_ROUNDS_TO_WIN;
  return Math.max(1, Math.min(5, n));
}

/**
 * Assign teams for a set of sessionIds given a mode.
 * Returns Map<sid, teamId>.
 *   duel: 2 players -> 0, 1
 *   team: split into 2 teams by order (round-robin); extra player goes to team 0
 *   ffa:  each player is its own team (teamId === index)
 */
export function assignTeams(sids, mode) {
  const out = new Map();
  const cleanMode = sanitizeMode(mode);
  if (cleanMode === 'duel') {
    // duel: exactly 2; if more/less, still assign 0/1 round-robin
    sids.forEach((sid, i) => out.set(sid, i % 2));
  } else if (cleanMode === 'team') {
    sids.forEach((sid, i) => out.set(sid, i % 2));
  } else {
    // ffa: every player is solo
    sids.forEach((sid, i) => out.set(sid, i));
  }
  return out;
}

/**
 * Aggregate scores by team.
 * @param {Map<string, {score:number, hp:number}>|Array<{sid:string, score:number}>|MapSchema} players
 * @param {Map<string, number>} assignment - sid -> teamId
 * @returns {Map<number, number>} teamId -> total score
 */
export function scoresByTeam(players, assignment) {
  const totals = new Map();
  let entries;
  // Handle Map, MapSchema (has entries fn), or Array
  if (players instanceof Map || (players && typeof players.entries === 'function' && !Array.isArray(players))) {
    entries = [...players.entries()];
  } else if (Array.isArray(players)) {
    entries = players.map((p) => [p.sid, p]);
  } else {
    entries = Object.entries(players || {});
  }
  for (const [sid, p] of entries) {
    const team = assignment.get(sid);
    if (team === undefined) continue;
    // dead players' scores still count for team? Only living can win but score persists.
    totals.set(team, (totals.get(team) || 0) + (p.score || 0));
  }
  return totals;
}

/**
 * Determine round winner given current player scores.
 * @param {Map<string, {score:number, hp:number}>} players - sid -> PlayerState-like {score,hp}
 * @param {string} mode
 * @param {Map<string, number>} assignment
 * @param {number} targetScore - score needed to win a round
 * @returns {{kind:'player', sid:string}|{kind:'team', teamId:number}|null}
 */
export function roundWinner(players, mode, assignment, targetScore) {
  const cleanMode = sanitizeMode(mode);
  if (cleanMode === 'team') {
    const totals = scoresByTeam(players, assignment);
    for (const [team, score] of totals) {
      if (score >= targetScore) {
        // ensure at least one living player on that team (corpses cannot win alone if all dead?)
        let hasLiving = false;
        // players may be Map/MapSchema or Array
        if (players instanceof Map || (players && typeof players.entries === 'function' && !Array.isArray(players))) {
          for (const [sid, p] of players) {
            if (assignment.get(sid) === team && p.hp > 0) { hasLiving = true; break; }
          }
        } else if (Array.isArray(players)) {
          for (const p of players) {
            if (assignment.get(p.sid) === team && p.hp > 0) { hasLiving = true; break; }
          }
        }
        if (hasLiving) return { kind: 'team', teamId: team };
      }
    }
    return null;
  }
  // duel and ffa: individual score
  if (players instanceof Map || (players && typeof players.entries === 'function' && !Array.isArray(players))) {
    for (const [sid, p] of players) {
      if (p.hp <= 0) continue;
      if (p.score >= targetScore) return { kind: 'player', sid };
    }
  } else if (Array.isArray(players)) {
    for (const p of players) {
      if (p.hp <= 0) continue;
      if (p.score >= targetScore) return { kind: 'player', sid: p.sid };
    }
  }
  return null;
}

/**
 * Determine match winner given round win counts.
 * @param {Map<number|string, number>} roundWins - teamId or sid -> rounds won
 * @param {number} roundsToWin
 * @returns {number|string|null} winning key or null
 */
export function matchWinner(roundWins, roundsToWin) {
  for (const [key, wins] of roundWins) {
    if (wins >= roundsToWin) return key;
  }
  return null;
}

/**
 * Minimum players required to start a mode.
 * Reads from SERVER.arena if available, else defaults.
 */
export function minPlayersForMode(mode) {
  const m = sanitizeMode(mode);
  const cfg = SERVER.arena || {};
  if (m === 'duel') return cfg.duel?.minPlayers ?? 2;
  if (m === 'team') return cfg.team?.minPlayers ?? 4;
  return cfg.ffa?.minPlayers ?? 2;
}

export function maxPlayersForMode(mode) {
  const m = sanitizeMode(mode);
  const cfg = SERVER.arena || {};
  if (m === 'duel') return cfg.duel?.maxPlayers ?? 2;
  if (m === 'team') return cfg.team?.maxPlayers ?? 12;
  return cfg.ffa?.maxPlayers ?? 12;
}

/** Human label for a mode. */
export function modeLabel(mode) {
  const m = sanitizeMode(mode);
  if (m === 'duel') return 'Duel';
  if (m === 'team') return 'Team';
  return 'FFA';
}
