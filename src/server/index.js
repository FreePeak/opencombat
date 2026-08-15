// Bootstrap: one process serves both the game (WebSocket + matchmaking)
// and the static client files (index.html + assets) over HTTP on the same
// port, so `npm run serve` is all it takes to play.
//
// Colyseus 0.17 wiring: the Server takes a WebSocketTransport bound to our
// own http.Server, plus an express callback that configures the transport's
// express app (matchmaking routes + our static file serving share it).
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server, WebSocketTransport } from 'colyseus';
import { SERVER } from './config.js';
import GameRoom from './rooms/GameRoom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '../..'); // game root: index.html lives there

const gameServer = new Server({
  transport: new WebSocketTransport({ server: http.createServer() }),
  express: (app) => app.use(express.static(clientDir))
});

gameServer.define('game', GameRoom);

await gameServer.listen(SERVER.port);
console.log(`[opengame] listening on http://localhost:${SERVER.port}`);
console.log('[opengame] open http://localhost:' + SERVER.port + ' in two browser tabs to test multiplayer');
