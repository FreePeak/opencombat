// Bootstrap: one process serves both the game (WebSocket + matchmaking)
// and the static client files over HTTP on the same port, so `npm run serve`
// is all it takes to play.
//
// Colyseus 0.17 wiring: the Server takes a WebSocketTransport bound to our
// own http.Server, plus an express callback that configures the transport's
// express app (matchmaking routes + health/metrics + static serving share
// it — see http.js).
//
// Graceful shutdown: SIGTERM/SIGINT stop the matchmaker, dispose every room
// and close the server (gracefullyShutdown(true) also exits the process).
import http from 'node:http';
import { Server, WebSocketTransport, RedisPresence } from 'colyseus';
import { SERVER } from './config.js';
import { buildHttpApp, attachHttpLogging } from './http.js';
import GameRoom from './rooms/GameRoom.js';
import ArenaRoom from './rooms/ArenaRoom.js';
import LobbyRoom from './rooms/LobbyRoom.js';
import WorldRoom from './rooms/WorldRoom.js';
import { log } from './log.js';

const httpServer = http.createServer();
// Raw request logger: sees every HTTP request, including /matchmake* which
// express middleware never reaches (Colyseus 0.17 routes those itself).
attachHttpLogging(httpServer);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: (app) => buildHttpApp(app),
  // Presence: Redis when REDIS_URL is set (multi-process deploys share
  // matchmaking + room state through it); otherwise the in-memory
  // LocalPresence keeps the single-process default.
  presence: SERVER.redis.url ? new RedisPresence(SERVER.redis.url) : undefined
});

gameServer.define('game', GameRoom);
gameServer.define('arena', ArenaRoom);
gameServer.define('lobby', LobbyRoom);
gameServer.define('world', WorldRoom);

await gameServer.listen(SERVER.port);
log('server_listening', { port: SERVER.port, publicUrl: SERVER.publicUrl || '(same-origin)', redis: SERVER.redis.url ? 'yes' : 'no' });

// Startup self-check: the express callback must have mounted, otherwise the
// port answers with Colyseus' default app ("Colyseus 0.17.50" on /) and the
// browser client silently never loads. Fail fast instead of serving nothing.
{
  const res = await fetch(`http://127.0.0.1:${SERVER.port}/`);
  const body = await res.text();
  if (!body.includes('<!DOCTYPE html>')) {
    log('static_serving_broken', { status: res.status, bodyStart: body.slice(0, 40) });
    console.error('[opengame] static serving is NOT mounted — restart the process');
    process.exit(1);
  }
}

// Graceful shutdown: Colyseus registers its own SIGINT/SIGTERM/SIGUSR2
// handlers (Server option `gracefullyShutdown`, default true) which dispose
// rooms, close the transport and exit the process. We only log it — adding
// our own signal handlers here would double-fire the shutdown.
gameServer.onBeforeShutdown((err) => {
  log('shutdown', { reason: err ? 'error' : 'signal', message: err?.message });
});
