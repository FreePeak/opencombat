// colyseus.js client wrapper: connect, join the room, forward intents.
// colyseus.js (the @colyseus/sdk UMD build) is loaded as the global
// `Colyseus` from index.html; the root schema is OUR StateSchema.js, so
// server and client share one definition of the wire format.
import { CONFIG } from './config.js';
import { WorldState } from './server/schema/StateSchema.js';
import { joinErrorMessage } from './joinError.js';

export { joinErrorMessage };

export const client = new Colyseus.Client(CONFIG.serverUrl);

/** Connect and join (or create) the arena room, carrying the chosen name. */
export async function joinGame(name, character) {
  // rootSchema lets the client decode the binary state patches; without it
  // room.state stays undefined (schema-based serialization). The name and
  // the chosen character index ride the join options to the server, which
  // sanitizes both into PlayerState.
  return client.joinOrCreate('game', { name, character }, WorldState);
}

/** Re-join a dropped connection using the colyseus reconnection token. */
export function reconnectRoom(room, name) {
  return client.reconnect(room.reconnectionToken, WorldState);
}

/** Send one input intent. Positions are server-authoritative. */
export function sendInput(room, dirX, dirZ, attack, anim) {
  room.send('input', { dirX, dirZ, attack, anim });
}

/** Request respawn after death (server validates hp <= 0 + match phase). */
export function sendRespawn(room) {
  room.send('respawn');
}

/** Request a fresh match after game over (server resets the world). */
export function sendPlayAgain(room) {
  room.send('playAgain');
}
