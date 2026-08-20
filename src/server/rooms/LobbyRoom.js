// LobbyRoom — queue → redirect matchmaking for arena creation.
// Clients join the lobby, declare their preferred mode (duel/team/ffa) + pve
// toggle + roundsToWin, then the keeper periodically batches compatible queues
// and redirects them to a freshly minted ArenaRoom via matchMaker
// reservation (queue → create → reserve → redirect). The lobby itself never
// runs a simulation, just the queue ticker.

import { Room } from 'colyseus';
import { matchMaker } from 'colyseus';
import { LobbyState } from '../schema/StateSchema.js';
import { SERVER } from '../config.js';
import { log, warn } from '../log.js';
import { takeToken, normalizeIp } from '../ratelimit.js';
import { sanitizeMode, sanitizePve, sanitizeRoundsToWin, minPlayersForMode, maxPlayersForMode } from '../../shared/arena.js';

export default class LobbyRoom extends Room {
  maxClients = SERVER.lobby?.maxClients ?? 100;

  static instances = new Set();

  onCreate(options = {}) {
    LobbyRoom.instances.add(this);
    this.autoDispose = false;
    this.setState(new LobbyState());
    // In-memory queue: sid -> { mode, pve, roundsToWin, name, character, client }
    this.queued = new Map();
    this.pendingGroups = new Set(); // keys currently being matched (avoid double create)
    this.lastQueueAt = Date.now();

    this.onMessage('queue', (client, msg) => this.onQueue(client, msg));
    this.onMessage('leaveQueue', (client) => this.onLeaveQueue(client));
    // Also support direct 'joinArena' via queue alias
    this.onMessage('joinQueue', (client, msg) => this.onQueue(client, msg));

    const tickMs = SERVER.lobby?.queueTickMs ?? 500;
    this.clock.setInterval(() => {
      this.processQueue().catch((err) => this.warnEvent('queue_tick_failed', { error: err?.message }));
    }, tickMs);

    this.logEvent('lobby_create', { tickMs });
  }

  logEvent(event, fields = {}) {
    log(event, { roomId: this.roomId, ...fields });
  }
  warnEvent(event, fields = {}) {
    warn(event, { roomId: this.roomId, ...fields });
  }

  sanitizeName(raw) {
    const name = String(raw ?? '').trim().slice(0, 16);
    return name || 'player';
  }
  sanitizeCharacter(raw) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(SERVER.characters.count - 1, n));
  }

  onAuth(_client, _options, authContext) {
    const ip = normalizeIp(authContext?.ip);
    if (!takeToken(ip)) {
      this.warnEvent('join_rate_limited', { ip });
      throw new Error('too many join attempts — wait a few seconds and try again');
    }
    return true;
  }

  onJoin(client, options = {}) {
    const sid = client.sessionId;
    const name = this.sanitizeName(options.name);
    const character = this.sanitizeCharacter(options.character);
    this.logEvent('lobby_join', { sid, name, character, players: this.clients.length });
    // Store join options for potential auto-queue
    this.queued.set(sid, {
      // not queued until they explicitly send 'queue', but keep defaults for now
      _name: name,
      _character: character,
      _pending: true,
    });
    // If the join itself carries mode/pve, auto-queue immediately (tests use this)
    if (options.mode !== undefined || options.pve !== undefined || options.roundsToWin !== undefined) {
      this.onQueue(client, options);
    } else {
      // Mark as not yet queued (they must send a queue message)
      const entry = this.queued.get(sid);
      entry.queued = false;
      this.syncState();
    }
  }

  onLeave(client, code) {
    const sid = client.sessionId;
    this.queued.delete(sid);
    this.syncState();
    this.logEvent('lobby_leave', { sid, code });
  }

  onDispose() {
    LobbyRoom.instances.delete(this);
    this.logEvent('lobby_dispose');
  }

  onQueue(client, msg = {}) {
    const sid = client.sessionId;
    const mode = sanitizeMode(msg.mode ?? msg.arenaMode ?? 'ffa');
    const pve = sanitizePve(msg.pve ?? msg.arenaPve ?? SERVER.arena?.pveDefault ?? false);
    const roundsToWin = sanitizeRoundsToWin(msg.roundsToWin ?? SERVER.arena?.roundsToWin ?? 2);
    // Preserve name/character from join, allow override via queue msg
    const existing = this.queued.get(sid) || {};
    const name = this.sanitizeName(msg.name ?? existing._name ?? 'player');
    const character = this.sanitizeCharacter(msg.character ?? existing._character ?? 0);
    this.queued.set(sid, {
      mode,
      pve,
      roundsToWin,
      name,
      character,
      queued: true,
      updatedAt: Date.now(),
      client, // keep ref for direct send (also reachable via this.clients)
    });
    this.syncState();
    this.logEvent('lobby_queue', { sid, mode, pve, roundsToWin, name });
    // Acknowledge queue to client
    client.send('queued', { mode, pve, roundsToWin });
  }

  onLeaveQueue(client) {
    const sid = client.sessionId;
    if (this.queued.has(sid)) {
      // Keep the placeholder but mark as not queued (so leaveQueue is reversible without rejoin)
      const entry = this.queued.get(sid);
      entry.queued = false;
      this.syncState();
      this.logEvent('lobby_leave_queue', { sid });
      client.send('leftQueue', {});
    }
  }

  syncState() {
    // Sync minimal state to clients (queueCount = number of currently queued)
    const count = [...this.queued.values()].filter((e) => e.queued).length;
    this.state.queueCount = count;
    // Clear and repopulate queued map for debug (sid -> mode:pve)
    this.state.queued.clear();
    for (const [sid, e] of this.queued) {
      if (e.queued) this.state.queued.set(sid, `${e.mode}:${e.pve ? 'pve' : 'pvp'}:${e.roundsToWin}`);
    }
  }

  /** Group queued entries by (mode:pve:roundsToWin) and create arena rooms for ready groups. */
  async processQueue() {
    // Collect only actively queued entries
    const active = [...this.queued.entries()].filter(([, e]) => e.queued);
    if (active.length === 0) return;

    // Group by key
    const groups = new Map(); // key -> [{sid, entry}]
    for (const [sid, entry] of active) {
      const key = `${entry.mode}:${entry.pve}:${entry.roundsToWin}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ sid, entry });
    }

    for (const [key, list] of groups) {
      if (this.pendingGroups.has(key)) continue; // already creating for this key
      const mode = list[0].entry.mode;
      const min = minPlayersForMode(mode);
      if (list.length < min) continue;

      // Ready to match — take up to max for this mode (FIFO)
      const max = maxPlayersForMode(mode);
      // For duel, exactly 2; for team/ffa, take up to max but at least min.
      // Take a slice that respects max; if more than max queued, leftover will match next tick.
      const batch = list.slice(0, max);
      // If team mode and odd count, ensure even? But config team min 2; we allow 3 with one team having extra.
      this.pendingGroups.add(key);
      try {
        await this.createArenaForBatch(batch);
      } finally {
        this.pendingGroups.delete(key);
      }
    }
  }

  /** Create one arena room and redirect the batch via seat reservations. */
  async createArenaForBatch(batch) {
    if (batch.length === 0) return;
    const { mode, pve, roundsToWin } = batch[0].entry;
    const roundTargetScore = SERVER.arena?.roundTargetScore ?? 30;
    this.logEvent('lobby_match_attempt', { mode, pve, roundsToWin, players: batch.length, sids: batch.map((b) => b.sid) });

    let roomCache;
    try {
      roomCache = await matchMaker.createRoom('arena', { mode, pve, roundsToWin, roundTargetScore });
    } catch (err) {
      this.warnEvent('lobby_create_failed', { mode, error: err?.message });
      return;
    }

    this.logEvent('lobby_arena_created', { mode, roomId: roomCache.roomId, players: batch.length });

    // Reserve a seat for each client in the batch
    for (const { sid, entry } of batch) {
      try {
        const reservation = await matchMaker.reserveSeatFor(roomCache, {
          name: entry.name,
          character: entry.character,
        });
        // Find the live client object (may have left lobby since batch formed)
        const client = this.clients.find((c) => c.sessionId === sid) || entry.client;
        if (!client) {
          this.warnEvent('lobby_client_gone', { sid, roomId: roomCache.roomId });
          continue;
        }
        // Remove from queue BEFORE sending redirect (so processQueue doesn't rematch)
        this.queued.delete(sid);
        this.syncState();
        client.send('redirect', reservation);
        // Also send a friendlier 'seat' alias for clients that listen for it
        // (tests may check either name).
        // client.send('seat', reservation);
        this.logEvent('lobby_redirect', { sid, mode, roomId: roomCache.roomId });
      } catch (err) {
        this.warnEvent('lobby_reserve_failed', { sid, mode, error: err?.message });
        // Keep them queued for retry next tick? For now, leave queued if reservation fails.
        // If we already deleted, restore?
        if (!this.queued.has(sid)) {
          this.queued.set(sid, entry);
          this.syncState();
        }
      }
    }
  }
}
