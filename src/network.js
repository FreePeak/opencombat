// colyseus.js client wrapper: connect, join the room, forward intents.
// colyseus.js (the @colyseus/sdk UMD build) is loaded as the global
// `Colyseus` from index.html; the root schema is OUR StateSchema.js, so
// server and client share one definition of the wire format.
import { CONFIG } from './config.js';
import { WorldState } from './server/schema/StateSchema.js';
import { joinErrorMessage } from './joinError.js';

export { joinErrorMessage };

// The login screen (and ?server= links) can retarget the client at runtime
// via setServerUrl() — a fresh quick-tunnel URL every host session is the
// normal case. The SDK binds the endpoint at construction, so rebuild the
// client whenever CONFIG.serverUrl moved.
let lastUrl = CONFIG.serverUrl;
let client = new Colyseus.Client(CONFIG.serverUrl);
function currentClient() {
  if (CONFIG.serverUrl !== lastUrl) {
    lastUrl = CONFIG.serverUrl;
    client = new Colyseus.Client(CONFIG.serverUrl);
  }
  return client;
}

/** Quick server reachability probe: opens a raw WebSocket handshake against
 *  CONFIG.serverUrl. The transport upgrades any path, so a completed
 *  handshake means the matchmaker is up (multiplayer); an error/close/
 *  timeout means offline — the caller falls back to the browser-local
 *  simulation (see src/LocalRoom.js). The timeout is generous on purpose:
 *  a tunnelled server adds a public-internet round trip before the
 *  handshake completes. */
export function serverAvailable(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(CONFIG.serverUrl);
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    ws.onopen = () => done(true);
    ws.onerror = () => done(false);
    ws.onclose = () => done(false);
  });
}

/** Connect and join (or create) the arena room, carrying the chosen name. */
export async function joinGame(name, character) {
  // rootSchema lets the client decode the binary state patches; without it
  // room.state stays undefined (schema-based serialization). The name and
  // the chosen character index ride the join options to the server, which
  // sanitizes both into PlayerState.
  return currentClient().joinOrCreate('game', { name, character }, WorldState);
}

/** Re-join a dropped connection using the colyseus reconnection token. */
export function reconnectRoom(room, name) {
  return currentClient().reconnect(room.reconnectionToken, WorldState);
}

/** Send one input intent. Positions are server-authoritative. */
export function sendInput(room, dirX, dirZ, attack, skill, anim) {
  room.send('input', { dirX, dirZ, attack, skill, anim });
}

/** Request respawn after death (server validates hp <= 0 + match phase). */
export function sendRespawn(room) {
  room.send('respawn');
}

/** Request a fresh match after game over (server resets the world). */
export function sendPlayAgain(room) {
  room.send('playAgain');
}
