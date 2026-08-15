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
import { fileURLToPath } from 'node:url';
import express from 'express';
import { SERVER } from './config.js';
import GameRoom from './rooms/GameRoom.js';
import { log } from './log.js';
import { createLiveReload } from './liveReload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

// index.html is static, but in dev mode the live-reload script is injected
// at the <!-- @live-reload --> placeholder (a no-op comment in production).
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const RELOADER_SCRIPT = `<script>
(function () {
  if (!window.EventSource) return;
  var opened = false;
  var es = new EventSource('/__reload');
  es.onopen = function () { if (opened) location.reload(); opened = true; };
  es.onmessage = function (e) { if (e.data === 'reload') location.reload(); };
})();
</script>`;
const servedIndex = () =>
  SERVER.liveReload && indexHtml.includes('<!-- @live-reload -->')
    ? indexHtml.replace('<!-- @live-reload -->', RELOADER_SCRIPT)
    : indexHtml;

const headerIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

const liveRooms = () => {
  let players = 0;
  for (const room of GameRoom.instances) players += room.state.players.size;
  return { rooms: GameRoom.instances.size, players };
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
    const stats = GameRoom.stats;
    stats.inputTimes = stats.inputTimes.filter((t) => t >= cutoff); // bound growth
    const lines = [
      '# HELP opengame_rooms Number of active game rooms',
      '# TYPE opengame_rooms gauge',
      `opengame_rooms ${rooms}`,
      '# HELP opengame_players Connected players across all rooms',
      '# TYPE opengame_players gauge',
      `opengame_players ${players}`,
      '# HELP opengame_tick_ms Duration of the last fixed-timestep update',
      '# TYPE opengame_tick_ms gauge',
      `opengame_tick_ms ${stats.lastTickMs.toFixed(3)}`,
      '# HELP opengame_inputs_per_sec Input messages accepted in the last second',
      '# TYPE opengame_inputs_per_sec gauge',
      `opengame_inputs_per_sec ${stats.inputTimes.length}`
    ];
    res.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  });

  // --- Client boot config (env > location.host > localhost chain) ----------
  app.get('/env.js', (_req, res) => {
    res.type('application/javascript')
      .set('Cache-Control', 'no-cache')
      .send(`window.__OPENGAME__ = ${JSON.stringify({
        wsUrl: SERVER.publicWsUrl,
        shadows: !SERVER.disableShadows
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
    res.type('html').set('Cache-Control', 'no-cache').send(servedIndex());
  });
  app.use('/assets', express.static(path.join(root, 'assets'), { maxAge: '1d', etag: true }));
  // Zero-build client: ES modules load directly from /src. Server internals
  // are denied — only the schema shared with the server is reachable.
  app.use('/src', (req, res, next) => {
    const rel = req.path;
    if (rel.startsWith('/server/') && rel !== '/server/schema/StateSchema.js') {
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  }, express.static(path.join(root, 'src'), { maxAge: 0, etag: true }));

  // Everything else is not served.
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));

  return app;
}
