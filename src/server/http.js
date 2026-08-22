// Express app factory: health/metrics endpoints, restricted CORS, client
// boot-config injection (/env.js) and a WHITELISTED static surface. The
// whole game root is NOT exposed: only index.html, /assets and the client
// modules under /src are reachable; everything else (node_modules/,
// package.json, server internals, tests, README) 404s.
//
// NOTE: per-IP join rate limiting lives in the room's onAuth hook (see
// ratelimit.js) — Colyseus 0.17 routes /matchmake* through its own router
// dispatcher, bypassing express middleware entirely.
import path from 'node:path';
import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { SERVER } from './config.js';
import GameRoom from './rooms/GameRoom.js';
import ArenaRoom from './rooms/ArenaRoom.js';
import LobbyRoom from './rooms/LobbyRoom.js';
import WorldRoom from './rooms/WorldRoom.js';
import { log } from './log.js';
import { createLiveReload } from './liveReload.js';
// Daily Gauntlet public API: date/seed/modifier math from the shared module,
// streak reward table derived from the same source of truth.
import { utcDateStr, dailySeed, dailyModifiers, streakRewardXp } from '../shared/sim/dailyRun.js';
// Weekly Gauntlet public API: same shape as /api/daily, keyed by ISO week.
import { utcWeekKey, weeklySeed, weeklyModifiers, weeklyObjectives } from '../shared/sim/weeklyRun.js';
// Presence panel (PRD-presence.md): merged view of the live population registry.
import { listPresence, presenceCount } from './presence.js';
// OIDC login option (PRD-oidc-login.md): registers routes ONLY when the
// OIDC_* env config is present — guest behavior is untouched otherwise.
import { buildAuthRoutes } from './auth/oidc.js';
// Admin API (PRD-admin-api.md): token-guarded GDPR surface over persistence
// plus the append-only audit trail every admin action must record.
import { appendAudit, readTail } from './auditLog.js';
import { loadPlayer, cancelPendingSave } from './persistence.js';

// XP rewarded per consecutive-day streak length (day 1..7, capped).
const DAILY_REWARDS = [1, 2, 3, 4, 5, 6, 7].map(streakRewardXp);

// Weekly XP ladder tiers (weeklyRewardXp pays (tier+1)*150 for score
// thresholds 0/500/1500/3000/5000 — tiers 1..5 below mirror that ladder).
const WEEKLY_REWARDS = [1, 2, 3, 4, 5].map((tier) => tier * 150);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

// index.html is static, but in dev mode the live-reload script is injected
// at the <!-- @live-reload --> placeholder (a no-op comment in production).
// Read lazily behind an mtime guard so dev edits to index.html show up
// without a server restart.
let indexCache = { mtimeMs: -1, html: '' };
const loadIndexHtml = () => {
  const file = path.join(root, 'index.html');
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (mtimeMs !== indexCache.mtimeMs) {
    indexCache = { mtimeMs, html: fs.readFileSync(file, 'utf8') };
  }
  return indexCache.html;
};
const RELOADER_SCRIPT = `<script>
(function () {
  if (!window.EventSource) return;
  var opened = false;
  var es = new EventSource('/__reload');
  es.onopen = function () { if (opened) location.reload(); opened = true; };
  es.onmessage = function (e) { if (e.data === 'reload') location.reload(); };
})();
</script>`;
const servedIndex = () => {
  const html = loadIndexHtml();
  return SERVER.liveReload && html.includes('<!-- @live-reload -->')
    ? html.replace('<!-- @live-reload -->', RELOADER_SCRIPT)
    : html;
};

// Air-gapped asset vendoring (PRD-airgap-vendoring.md): with VENDORED_ASSETS=1
// the served index swaps every pinned jsDelivr URL for its committed copy
// under /vendor/* (assets/vendor mirrors the CDN path shape, so a single
// prefix replace covers all URL families: three build + examples/jsm/,
// @colyseus/schema, @colyseus/sdk). The rewritten string is cached behind
// the same mtime guard as the raw HTML; default mode stays byte-identical.
const CDN_PREFIX = 'https://cdn.jsdelivr.net/';
let vendorIndexCache = { mtimeMs: -1, html: '' };
const vendoredServedIndex = () => {
  const html = servedIndex();
  if (indexCache.mtimeMs !== vendorIndexCache.mtimeMs) {
    vendorIndexCache = { mtimeMs: indexCache.mtimeMs, html: html.split(CDN_PREFIX).join('/vendor/') };
  }
  return vendorIndexCache.html;
};

const headerIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

// Admin token compare (PRD-admin-api.md): constant-time via timingSafeEqual
// on sha256 digests — hashing equalizes lengths so the primitive never throws
// on mismatched input sizes and leaks no length/timing signal. Exported for
// unit testing.
export function adminTokenMatches(provided, expected) {
  const a = createHash('sha256').update(String(provided ?? '')).digest();
  const b = createHash('sha256').update(String(expected ?? '')).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

const liveRooms = () => {
  let players = 0;
  let rooms = 0;
  for (const room of GameRoom.instances) { players += room.state.players.size; rooms++; }
  for (const room of ArenaRoom.instances) { players += room.state.players.size; rooms++; }
  for (const room of LobbyRoom.instances) { players += room.state.players?.size ?? room.state.queueCount ?? 0; rooms++; }
  for (const room of WorldRoom.instances) { players += room.state.players.size; rooms++; }
  return { rooms, players };
};

// Live Match Browser (PRD-live-matches.md): one detailed entry per live room,
// busiest first, for the client's LIVE MATCHES panel. Every per-room read is
// guarded — rooms dispose concurrently with the listing and a torn-down room
// must be skipped, never fail the API.
const listRooms = () => {
  const entries = [];
  // Spectator counts (PRD-waves-spectate.md): ONE presence scan per request
  // into Map<roomId, count>, then every room entry below gets annotated.
  const spectatorsByRoom = new Map();
  for (const p of listPresence()) {
    if (p.mode === 'spectating' && p.roomId) {
      spectatorsByRoom.set(p.roomId, (spectatorsByRoom.get(p.roomId) ?? 0) + 1);
    }
  }
  const push = (read) => {
    try {
      const entry = read();
      if (entry) {
        entry.spectators = spectatorsByRoom.get(entry.roomId) ?? 0;
        entries.push(entry);
      }
    } catch {} // disposed mid-read -> drop this room
  };
  for (const room of GameRoom.instances) {
    push(() => {
      const ms = room.state.matchState;
      const players = room.state.players.size;
      return {
        roomId: room.roomId,
        mode: room.mode === 'daily' || room.mode === 'weekly' ? room.mode : 'waves',
        players,
        phase: ['countdown', 'playing', 'intermission', 'gameover'].includes(ms) ? ms : 'lobby',
        canJoin: (ms === 'playing' || ms === 'intermission') && players < 8,
      };
    });
  }
  for (const room of ArenaRoom.instances) {
    push(() => {
      const players = room.state.players.size;
      return {
        roomId: room.roomId,
        mode: 'arena',
        ...(room.state.arenaMode ? { subMode: room.state.arenaMode } : {}),
        players,
        phase: players > 0 ? 'live' : 'lobby',
        canJoin: false,
      };
    });
  }
  for (const room of WorldRoom.instances) {
    push(() => ({
      roomId: room.roomId,
      mode: 'world',
      players: room.state.players.size,
      phase: 'live',
      canJoin: false,
    }));
  }
  for (const room of LobbyRoom.instances) {
    push(() => ({
      roomId: room.roomId,
      mode: 'lobby',
      players: room.state.players?.size ?? room.state.queueCount ?? 0,
      phase: 'lobby',
      canJoin: false,
    }));
  }
  return entries.sort((a, b) => b.players - a.players);
};

/**
 * Attach a raw http 'request' listener that only LOGS (never writes to the
 * response, so it is safe alongside Colyseus' router dispatcher). It sees
 * every HTTP request, including /matchmake* which express middleware never
 * reaches. Call before gameServer.listen().
 */
export function attachHttpLogging(server) {
  server.on('request', (req, res) => {
    res.on('finish', () => log('http', {
      method: req.method, path: req.url.split('?')[0], status: res.statusCode, ip: headerIp(req)
    }));
  });
}

export function buildHttpApp(app) {
  // `app` is the transport's express instance (WebSocketTransport mounts it
  // on the HTTP server); we configure it in place so Colyseus' matchmaking
  // routes and our routes share one app.
  app.disable('x-powered-by');

  // --- CORS: restricted to the configured public origin. With no PUBLIC_URL
  // the app is same-origin only and no CORS headers are ever emitted.
  const allowedOrigin = SERVER.publicUrl ? new URL(SERVER.publicUrl).origin : null;
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigin && origin === allowedOrigin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    next();
  });

  // --- Health + metrics ----------------------------------------------------
  app.get('/healthz', (_req, res) => {
    const { rooms, players } = liveRooms();
    res.json({ ok: true, rooms, players, uptime: Math.round(process.uptime() * 100) / 100 });
  });

  app.get('/metrics', (_req, res) => {
    const { rooms, players } = liveRooms();
    const cutoff = Date.now() - 1000;
    const gStats = GameRoom.stats;
    const aStats = ArenaRoom.stats;
    const wStats = WorldRoom.stats;
    gStats.inputTimes = gStats.inputTimes.filter((t) => t >= cutoff);
    aStats.inputTimes = aStats.inputTimes.filter((t) => t >= cutoff);
    wStats.inputTimes = wStats.inputTimes.filter((t) => t >= cutoff);
    const allInputs = gStats.inputTimes.length + aStats.inputTimes.length + wStats.inputTimes.length;
    const lastTick = Math.max(gStats.lastTickMs, aStats.lastTickMs, wStats.lastTickMs);
    const lines = [
      '# HELP opengame_rooms Number of active game rooms',
      '# TYPE opengame_rooms gauge',
      `opengame_rooms ${rooms}`,
      '# HELP opengame_players Connected players across all rooms',
      '# TYPE opengame_players gauge',
      `opengame_players ${players}`,
      '# HELP opengame_tick_ms Duration of the last fixed-timestep update',
      '# TYPE opengame_tick_ms gauge',
      `opengame_tick_ms ${lastTick.toFixed(3)}`,
      '# HELP opengame_inputs_per_sec Input messages accepted in the last second',
      '# TYPE opengame_inputs_per_sec gauge',
      `opengame_inputs_per_sec ${allInputs}`
    ];
    res.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  });

  // --- Client boot config (env > location.host > localhost chain) ----------
  app.get('/env.js', (_req, res) => {
    res.type('application/javascript')
      .set('Cache-Control', 'no-cache')
      .send(`window.__OPENGAME__ = ${JSON.stringify({
        wsUrl: SERVER.publicWsUrl,
        shadows: !SERVER.disableShadows,
        bloom: !!SERVER.bloomEnabled
      })};`);
  });

  // --- Dev live reload (SSE): pages subscribe, watcher broadcasts on
  // client-file changes; server restarts show up as a reconnect -> reload.
  const liveReload = createLiveReload({ root });
  if (liveReload) {
    liveReload.start();
    app.get('/__reload', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write(': connected\n\n');
      liveReload.clients.add(res);
      req.on('close', () => liveReload.clients.delete(res));
    });
  }

  // --- Static surface (whitelist; see header comment) ----------------------
  app.get('/', (_req, res) => {
    const html = process.env.VENDORED_ASSETS === '1' ? vendoredServedIndex() : servedIndex();
    res.type('html').set('Cache-Control', 'no-cache').send(html);
  });
  app.use('/assets', express.static(path.join(root, 'assets'), { maxAge: '1d', etag: true }));
  // --- Vendored CDN assets (PRD-airgap-vendoring.md): committed copies of
  // the pinned jsDelivr files. The env gate is read PER REQUEST (mirrors the
  // admin token pattern) so VENDORED_ASSETS flips without a restart; off ->
  // zero route surface, on -> JS MIME + immutable caching, unknown paths fall
  // through to the catch-all 404 below.
  const vendorStatic = express.static(path.join(root, 'assets', 'vendor'), {
    setHeaders(res, filePath) {
      res.setHeader(
        'Content-Type',
        filePath.endsWith('.mjs')
          ? 'text/javascript; charset=utf-8'
          : 'application/javascript; charset=utf-8'
      );
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  });
  app.use('/vendor', (req, res, next) => {
    if (process.env.VENDORED_ASSETS !== '1') return next();
    vendorStatic(req, res, next); // miss falls through -> catch-all 404 below
  });
  // Zero-build client: ES modules load directly from /src. Server internals
  // are denied — the exceptions are the modules the browser client itself
  // imports: the shared schema, the tunables (LocalRoom mirrors them for the
  // offline sim) and the shared movement math.
  const clientReachable = new Set([
    '/server/schema/StateSchema.js',
    '/server/config.js',
    '/server/movement.js'
  ]);
  app.use('/src', (req, res, next) => {
    const rel = req.path;
    if (rel.startsWith('/server/') && !clientReachable.has(rel)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  }, express.static(path.join(root, 'src'), { maxAge: 0, etag: true }));

  // --- Daily Gauntlet (PRD-daily-gauntlet.md): today's modifiers, streak
  // reward table and the day's leaderboard, scanned synchronously from the
  // per-player JSON files. Registered BEFORE the catch-all below.
  app.get('/api/daily', (_req, res) => {
    const date = utcDateStr();
    const mods = dailyModifiers(date);
    const leaderboard = [];
    const dir = path.resolve(root, SERVER.persistence?.dir || 'data/players');
    let files = [];
    try { files = fs.readdirSync(dir); } catch {} // no data dir yet -> empty board
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        // Tolerate malformed/partial files: skip them, never fail the API.
        const rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (rec?.daily?.date === date) {
          leaderboard.push({
            name: rec.name ?? file.replace(/\.json$/, ''),
            score: rec.daily.bestScore,
          });
        }
      } catch {}
    }
    leaderboard.sort((a, b) => b.score - a.score);
    res.json({
      date,
      seed: dailySeed(date),
      modifiers: {
        label: mods.label,
        description: mods.description,
        enemyHpMul: mods.enemyHpMul,
        enemySpeedMul: mods.enemySpeedMul,
        enemyCountBonus: mods.enemyCountBonus,
      },
      rewards: DAILY_REWARDS,
      leaderboard: leaderboard.slice(0, 10),
    });
  });

  // --- Weekly Gauntlet (PRD-weekly-gauntlet.md): mirror of /api/daily keyed
  // by ISO week — stacked modifiers, flat reward ladder and the week's
  // leaderboard, scanned synchronously from the per-player JSON files.
  // Registered BEFORE the catch-all below.
  app.get('/api/weekly', (_req, res) => {
    const week = utcWeekKey();
    const mods = weeklyModifiers(week);
    const leaderboard = [];
    const dir = path.resolve(root, SERVER.persistence?.dir || 'data/players');
    let files = [];
    try { files = fs.readdirSync(dir); } catch {} // no data dir yet -> empty board
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        // Tolerate malformed/partial files: skip them, never fail the API.
        const rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (rec?.weekly?.week === week) {
          leaderboard.push({
            name: rec.name ?? file.replace(/\.json$/, ''),
            score: rec.weekly.bestScore,
            objectivesDone: (rec.weekly.objectives ?? []).filter(o => o.done === true).length,
          });
        }
      } catch {}
    }
    leaderboard.sort((a, b) => b.score - a.score);
    res.json({
      week,
      seed: weeklySeed(week),
      objectives: weeklyObjectives(week).map(d => ({ id: d.id, description: d.description })),
      modifiers: {
        label: mods.label,
        description: mods.description,
        enemyHpMul: mods.enemyHpMul,
        enemySpeedMul: mods.enemySpeedMul,
        enemyCountBonus: mods.enemyCountBonus,
      },
      rewards: WEEKLY_REWARDS,
      leaderboard: leaderboard.slice(0, 10),
    });
  });

  // --- Online Now (PRD-presence.md): live population across ALL room types,
  // straight from the presence registry (authoritative). Registered BEFORE
  // the catch-all below.
  app.get('/api/players', (_req, res) => {
    res.json({
      count: presenceCount(),
      players: listPresence().map(({ name, mode }) => ({ name, mode })),
    });
  });

  // --- Live Match Browser (PRD-live-matches.md): detailed listing of every
  // live room. Registered BEFORE the catch-all below.
  app.get('/api/rooms', (_req, res) => {
    res.json({ rooms: listRooms() });
  });

  // --- OIDC login (PRD-oidc-login.md): /auth/* + /api/me. No-op (registers
  // nothing) unless OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET are set.
  // Registered BEFORE the catch-all below.
  buildAuthRoutes(app);

  // --- Admin API (PRD-admin-api.md): token-guarded GDPR surface over the
  // persistence layer. ADMIN_TOKEN unset -> every /api/admin/* answers 404
  // (feature off, zero route surface). Auth is `Authorization: Bearer <token>`
  // compared constant-time on sha256 digests (see adminTokenMatches). The env
  // var is read lazily PER REQUEST so deployments can flip it without a
  // restart (and tests can toggle it mid-run). Registered BEFORE the
  // catch-all below.
  const adminGuard = (req, res, next) => {
    if (!process.env.ADMIN_TOKEN) return res.status(404).end();
    const provided = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!adminTokenMatches(provided, process.env.ADMIN_TOKEN)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
  // Mirrors persistence.safeName (trim, 16 cap, FS-safe charset fallback).
  const adminPlayerName = (raw) =>
    String(raw ?? '').trim().slice(0, 16).replace(/[^a-zA-Z0-9_-]/g, '_') || 'player';

  app.get('/api/admin/players', adminGuard, (_req, res) => {
    const dir = path.resolve(root, SERVER.persistence?.dir || 'data/players');
    let files = [];
    try { files = fs.readdirSync(dir); } catch {} // no data dir yet -> empty list
    const players = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        // Tolerate malformed/partial files: skip them, never fail the listing.
        const rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        players.push({
          name: rec.name ?? file.replace(/\.json$/, ''),
          level: rec.level,
          career: { bestWave: rec.career?.bestWave, bestScore: rec.career?.bestScore },
        });
      } catch {}
    }
    res.json({ players });
  });

  app.get('/api/admin/players/:name', adminGuard, (req, res) => {
    const name = adminPlayerName(req.params.name);
    const record = loadPlayer(name); // full parsed record -> GDPR portability
    appendAudit({ action: 'export', target: name, outcome: record ? 'ok' : 'fail' });
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  });

  app.delete('/api/admin/players/:name', adminGuard, (req, res) => {
    const name = adminPlayerName(req.params.name);
    // Cancel any queued debounced save FIRST so the in-flight writer cannot
    // resurrect the file right after unlink (durable delete).
    cancelPendingSave(name);
    const file = path.join(path.resolve(root, SERVER.persistence?.dir || 'data/players'), `${name}.json`);
    try {
      fs.unlinkSync(file);
    } catch (err) {
      const missing = err?.code === 'ENOENT';
      appendAudit({ action: 'delete', target: name, outcome: 'fail' }); // BEFORE responding
      return res.status(missing ? 404 : 500).json({ error: missing ? 'not found' : 'delete failed' });
    }
    appendAudit({ action: 'delete', target: name, outcome: 'ok' }); // BEFORE responding
    res.json({ deleted: name });
  });

  app.get('/api/admin/audit', adminGuard, (_req, res) => {
    res.json({ entries: readTail(100) });
  });

  // Everything else is not served.
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));

  return app;
}
