# opengame — Multiplayer 3D Arena Survival

Server-authoritative arena survival in the browser: **Three.js** renders the
world, **Colyseus** owns the simulation (positions, HP, score, match
lifecycle, enemy AI, power-ups). Open the same URL in two tabs and fight for
the same orbs.

No build step: the client is ES modules + CDN importmaps; the server is a
single Node process that also serves the client files, so one command runs
everything.

## Run

Bare (local dev):

```bash
cd games/opengame
npm install
npm run serve        # server + client on http://localhost:2567
npm run dev          # same, PLUS auto-reload: server restarts on server-file
                     # changes (node --watch) and open pages reload when
                     # client files (src/, assets/, index.html) change
```

Live reload is enabled outside `NODE_ENV=production` (disable with
`LIVE_RELOAD=0`). It works via a small SSE endpoint (`/__reload`) injected
into index.html — zero extra dependencies, nothing to install.

Docker (production-ish):

```bash
docker compose up --build
# app on http://localhost:2567 (+ redis container for presence)
# no docker? same thing: node src/server/index.js
```

Open **http://localhost:2567 in two browser tabs** to test multiplayer —
both players share one arena, one orb pool, one match, and the same enemies.

Tooling: `npm run check` (node --check on every file) and
`npm run test` (FSM unit test + headless multiplayer/integration test).
For browser-only regressions (schema API misuse, scene wiring errors)
run the Playwright e2e against a running server:
`python3 test/browser.test.py`.

## Environment

All optional; the defaults run a single-process game on :2567.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `2567` | HTTP + WebSocket port |
| `PUBLIC_URL` | *(empty)* | Public origin clients load from (e.g. `https://game.example.com`). Injected into `/env.js`; the client connects to its `ws(s)://` twin. Also the only allowed CORS origin. Empty = same-origin only |
| `DISABLE_SHADOWS` | *(unset)* | `1`/`true` disables shadow maps for low-end clients (injected into `/env.js`) |
| `REDIS_URL` | *(empty)* | Redis URL → Colyseus `RedisPresence` (multi-process matchmaking). Empty = in-memory presence |
| `TICK_MS` | `50` | Fixed simulation timestep |
| `RATE_LIMIT_CAPACITY` | `10` | Per-IP join token-bucket burst size (refill 0.5 tokens/s) |

## Deployment notes

- **Play with friends (GitHub Pages + Cloudflare Tunnel)** — the client is a
  static site, so the free GitHub Pages host serves it; your own machine
  runs the authoritative server and a Cloudflare Tunnel exposes it with a
  stable `wss://` URL (no port forwarding, no public IP):

  1. One-time Pages setup: push this repo to GitHub, enable **Settings →
     Pages → Deploy from branch → `master` / root**. The game (and the
     committed static `env.js` + `.nojekyll`) is served at your Pages URL.
  2. One-time tunnel setup (needs a free Cloudflare account + a domain in
     Cloudflare; see `cloudflared/config.example.yml`):
     ```bash
     brew install cloudflared
     cloudflared tunnel login
     cloudflared tunnel create opencombat
     cloudflared tunnel route dns opencombat game.yourdomain.com
     ```
  3. Host a match:
     ```bash
     npm run serve                                   # game server on :2567
     cloudflared tunnel --config cloudflared/config.yml run
     ```
  4. Point the Pages client at your tunnel — any of:
     - **Login-screen field**: players type the host (e.g.
       `some-words.trycloudflare.com`) into the *game server* box on the
       first page; the value is remembered for their next visit. This is
       the flow for quick tunnels, whose URL changes every run.
     - **Share link**: `…/opencombat/?server=game.yourdomain.com` (sticky
       per player via localStorage, and it prefills the field).
     - **Default for everyone**: set `wsUrl: 'wss://game.yourdomain.com'`
       in the committed `env.js` — best with a named tunnel's stable
       hostname.
     Matchmaking CORS is built into Colyseus 0.17 (`/matchmake/*` answers
     preflight and allows cross-origin), so the Pages origin works as-is.

  When your server/tunnel is down, the Pages page automatically falls back
  to the browser-local single-player simulation (src/LocalRoom.js) and
  shows an **OFFLINE — SOLO MODE** badge; a `?server=` link or a reachable
  default server upgrades visitors straight into the multiplayer room.
  Domainless quick test: `cloudflared tunnel --url http://localhost:2567`
  (random `*.trycloudflare.com` URL — share it as `?server=<host>`).

- **TLS / WSS**: terminate TLS at a reverse proxy (nginx/Caddy/Traefik) in
  front of :2567, set `PUBLIC_URL=https://game.example.com`, and proxy both
  HTTP and the `ws`/`wss` upgrade for `/` (the WebSocket path is the same
  origin). The client then connects with `wss://` automatically — it never
  hardcodes a host.
- **Scaling**: set `REDIS_URL` and run multiple replicas behind a load
  balancer (presence keeps matchmaking + room state consistent across
  processes). Health check: `GET /healthz` (used by the Docker healthcheck).
- **Security defaults**: only `index.html`, `/assets`, `/env.js` and the
  client modules under `/src` are served — `node_modules/`, `package.json`,
  tests and docs all 404, and under `/src/server/` only the three modules
  the browser client imports (shared schema, tunables, movement math for
  the offline sim). Fresh joins are rate-limited per
  IP (token bucket at the connection/`onAuth` layer — Colyseus 0.17 routes
  `/matchmake*` through its own dispatcher, so express middleware cannot see
  them) and input is validated server-side (see "Server hardening"). CORS is
  denied for every origin except `PUBLIC_URL`.
- **Observability**: everything logs as JSON lines; `GET /metrics` exposes
  Prometheus-style gauges (rooms, players, tick duration, inputs/sec).

## Controls

| Key | Action |
|-----|--------|
| W / A / S / D or arrows | Move (camera-relative) |
| J | Melee swing (0.8s cooldown, HUD bar) — works while moving |
| K | Character skill (0.8–4s cooldown per class) — works while moving |
| L (hold) | Block — roots you, negates frontal enemy contact and other players' attacks |
| M | Mute / unmute sound |
| Click a character card (login) | Choose Knight / Archer / Mage / Demon |

### Mobile (touch)

Touch controls activate automatically on phones/tablets (or with `?touch=1`):

| Control | Action |
|---------|--------|
| Left-half drag | Floating joystick — analog movement (partial deflection = slower) |
| ⚔ button (bottom-right) | Melee swing — tap repeatedly while off cooldown |
| ✨ button (above ⚔) | Character skill |
| 🛡 button (left of ⚔) | Block (hold) |
| 🔊 button (bottom-center) | Mute / unmute sound |

## Match lifecycle (server-authoritative)

`LOBBY → COUNTDOWN → PLAYING → GAME_OVER`, enforced entirely on the server;
clients only render `matchState` + the countdown number.

- **Countdown start**: with `match.minPlayers = 1` (default) the 3-2-1-GO
  countdown starts as soon as the first player joins — no waiting for
  friends. Raise the threshold in `src/server/config.js` to wait for a
  full lobby. During the lobby players can move freely; the world is frozen
  during the countdown.
- **Game over**: first player to `match.targetScore` (default 100) wins.
  Alternatively set `match.matchDurationSeconds` for a timed match (highest
  score wins). Winner + final scores are broadcast; the results overlay has
  a **play again** button that resets orbs/enemies/scores/effects in place
  and starts a new countdown — same room, same players. A timed match that
  ends with no players left broadcasts an empty winner (never `null`).
- Death mid-match is not game over: click to respawn. Respawn clears
  power-up effects, restores full HP and grants 1s spawn invulnerability.

## Design decisions (documented per the production-readiness checklist)

- **Dead players are ghosts-in-reverse**: at `hp <= 0` a player is frozen
  (movement input ignored), cannot collect orbs/power-ups, cannot attack,
  is excluded from enemy targeting and cannot trigger the win condition.
  Only the respawn click works.
- **Attacks are match-gated**: melee is only valid while
  `matchState === 'playing'` — no swinging during the countdown or on the
  game-over screen.
- **Join during game-over**: a player joining a room where everyone else
  left gets an instant fresh match (the room resets itself and starts a new
  countdown). If other players are present, anyone can click PLAY AGAIN.
- **Room cap**: `match.maxClients` (default 12) — a room never fills
  without bound. New players get a fresh room instead.
- **Empty-room cleanup**: rooms with 0 players are disposed after
  `match.emptyRoomTtlMs` (default 60s; Colyseus' 1s auto-dispose is
  disabled so game-over rooms survive for latecomers).
- **Presence**: single process uses the in-memory presence; set `REDIS_URL`
  to share matchmaking + room state across processes.
- **Fixed timestep**: the simulation runs on `tickMs` (50ms) but `dt` is
  computed from real elapsed time (clock-drift compensation, clamped at
  0.25s) so effects/movement stay correct under load.

## Power-ups

Three types, rendered as pulsing glowing orbs; the server decides pickups
and applies the timed effects, broadcasting the remaining duration in
`PlayerState.effects` (name → ms). After a pickup the power-up hides and
respawns elsewhere after `powerUps.respawnSeconds`.

| Type | Effect | Visual |
|------|--------|--------|
| SPEED | 2x move speed, 5s | cyan trail particles |
| SHIELD | blocks one enemy hit (consumed) | translucent bubble |
| DOUBLE | 2x orb score, 10s | gold tint |

## Combat

**Attacks** — Melee (J) and skills (K) damage enemies and other players. Both
work while moving; the only gate is holding L (block) — you cannot swing or
cast while guarding.

**Blocking (hold L)** — Roots you and negates any hit whose source lies inside
your frontal hemisphere (the attacker must be in front of you). Successful
blocks deal **zero damage** and emit a "BLOCKED" message; a hit from behind
still lands. Enemy contact damage is also blocked frontally.

**Player vs player** — Melee and skills now hurt other players (PvP damage is
separate from enemy damage). This makes blocking meaningful in multiplayer.

**Enemy health bars** — Every enemy displays a billboarded bar above its head
showing current HP (green → red as it drains). Killing an enemy respawns it
elsewhere at full HP.

## Audio (procedural, zero files)

`src/audio/SoundManager.js` synthesizes everything with WebAudio: pickup
blip, power-up arpeggio, swing sweep, hit thud, death sweep, countdown tick,
game-over sting, and a soft looping pad (two detuned sawtooths through a
lowpass). Mute with **M**; volume persists in localStorage
(`opengame.volume`, `opengame.muted`).

## Names, colors, leaderboard

- Pre-join name form; the name rides the join options to the server and is
  stored in `PlayerState.name`.
- The server assigns a stable color from its palette (same name → same
  color) and broadcasts it; the character tint and the billboarded nametag
  (name + HP, projected above the head) use it.
- HUD leaderboard: top 5 + you, sorted live by score.

## Performance & stability

- Object pooling everywhere: orbs, power-ups and enemy meshes are fixed
  slots reused from the state arrays; particles and floating numbers come
  from `ParticlePool` / `FloatingTextPool` (no per-event allocation).
- devicePixelRatio clamped (max 2) and shadow-map size in
  `CONFIG.renderer`; the render loop pauses when the tab is hidden.
- Client resilience: on a socket drop the sdk's automatic reconnection
  resumes the same session (server holds the seat + player state for
  `match.reconnectGraceMs`); the client shows a "connection lost —
  retrying" overlay, and falls back to a fresh join if the seat expired.
- Server hardening: input messages are rate-capped (30/s, excess dropped
  with a warning) and movement deltas are validated (finite, magnitude ≤ 1)
  so a hostile client cannot move faster than the server's own speed.
  Fresh joins are additionally rate-limited per IP (token bucket,
  `SERVER.rateLimit`, enforced in the room's `onAuth` — see
  `src/server/ratelimit.js`), names are sanitized server-side and the
  leaderboard HTML is escaped client-side — these are security boundaries,
  not tuning knobs.
- Resilience: model loading has a timeout with a clear error message; a
  missing WebGL context or a failed boot surfaces in the login overlay; a
  watchdog shows an error if the CDN never loads at all; the canvas follows
  window resizes.

## Layout

```
opengame/
|-- index.html                    # importmap (three) + UMD (colyseus.js) + HUD/overlays
|-- package.json                  # serve / check / test scripts
|-- Dockerfile                    # node:20-alpine, npm ci, healthcheck
|-- docker-compose.yml            # app + optional redis (presence)
|-- assets/
|   |-- characters/adventurer.glb # player model (CC0, Quaternius)
|   |-- enemies/orc.glb           # enemy model (CC0, Quaternius)
|   |-- props/tree.glb, rock.glb  # arena props (CC0, Quaternius)
|   |-- credits/                  # metadata.json + credits.csv (licenses)
|-- src/
|   |-- main.js                   # guarded boot: WebGL check, try/catch, rAF loop
|   |-- config.js                 # client visuals + ws-url fallback chain + shadows flag
|   |-- network.js                # join (with name), input, respawn, playAgain
|   |-- audio/SoundManager.js     # procedural WebAudio synth (no files)
|   |-- effects/
|   |   |-- ParticlePool.js       # pooled THREE.Points burst system
|   |   |-- FloatingTextPool.js   # pooled damage-number divs
|   |-- scenes/GameScene.js       # world, camera rig, resize, match UI, nametags, board
|   |-- entities/
|   |   |-- Player.js             # local controller: input + FSM + effects
|   |   |-- RemotePlayer.js       # lerped view + effects + nametag
|   |   |-- Enemy.js              # visual only — logic is server-side
|   |-- fsm/                      # StateMachine + Idle/Run (termgame API)
|   |-- server/
|   |   |-- index.js              # colyseus Server + graceful shutdown :2567
|   |   |-- config.js             # SERVER tunables + env overrides
|   |   |-- log.js                # JSON-lines structured logging
|   |   |-- ratelimit.js          # per-IP token bucket (join flood guard)
|   |   |-- http.js               # /healthz, /metrics, /env.js, CORS,
|   |   |                         #   whitelisted static serving
|   |   |-- schema/StateSchema.js # WorldState/PlayerState/OrbState/...
|   |   |-- rooms/GameRoom.js     # lifecycle + fixed-timestep simulation
|-- test/
|   |-- fsm.test.mjs              # node:assert FSM unit test
|   |-- multiplayer.test.mjs      # headless: lifecycle, sync, power-ups,
|   |                             #   cooldown, reconnect, ghost players,
|   |                             #   attack gate, respawn, win edge cases,
|   |                             #   healthz/metrics/static whitelist
```

## Artwork

All models are low-poly and free-licensed (details, source URLs and licenses in
`assets/credits/`; policy: CC0 preferred, CC-BY with attribution):

- **Playable roster** (chosen on the login screen, `PlayerState.character`):
  Knight by Dawid2K (CC-BY 3.0, static rig — the client plays a
  procedural idle/run/swing; carries the CC0 Quaternius sword prop),
  Archer = Hooded Adventurer (CC0, Quaternius, procedural bow),
  Mage = Animated Wizard (CC-BY 3.0, Quaternius, staff attack clip),
  Demon (CC0, Quaternius, trident).
- **Enemy**: Orc (CC0, Quaternius). **Props**: tree + rock (CC0, Quaternius).

Animated GLBs ship skeletal clips (idle/run/attack/hit) played via
`THREE.AnimationMixer`; the selection is cosmetic — every class shares the
same melee combat rules.

## What was verified

1. `npm install` succeeds (colyseus 0.17.10, @colyseus/sdk 0.17.43, express 5.2.1 pinned).
2. `npm run check` — every server/client/test file passes `node --check`.
3. `npm run test` — FSM unit test, movement/attack smoothness contracts, and a
   headless integration test that boots the real server and proves:
   - countdown → playing on first join, movement sync, power-up pickup,
     attack-cooldown enforcement, two-client visibility, automatic reconnection
   - **GHOST** (hp ≤ 0 → frozen, no pickup/score/attack/win, enemies ignore corpse)
   - **ATTACK GATE** (countdown/game-over swings deal no damage)
   - **RESPAWN** (effects cleared, hp restored, spawn invulnerability set)
   - **WIN** (score win with living players only, timed end broadcasts empty
     winner, play-again fully resets state, join during game-over auto-restarts)
   - **BLOCK** (L root + frontal negation, rear exposure, blocked message)
   - **PVP** (melee/skills hurt other players, guard negates it)
   - **KILL-UNTIL-DEATH** (all 4 character classes' J/K reduce enemy HP; killed
     enemies respawn elsewhere at full HP)
   - **MOVE + ATTACK** (J and K work while moving, only L blocks them)
4. `npm run serve` + curl: the client HTML loads (200, `no-cache`), the
   matchmake endpoint answers (200), the WebSocket upgrade responds (101),
   static assets (JS modules, GLBs) are served, `package.json`/`node_modules`
   return 404, `/healthz` and `/metrics` answer, and SIGTERM shuts the
   server down cleanly (no "Error: disposing" noise).
