# opengame — Multiplayer 3D Arena Survival

Server-authoritative arena survival in the browser: **Three.js** renders the
world, **Colyseus** owns the simulation (positions, HP, score, match
lifecycle, enemy AI, power-ups). Open the same URL in two tabs and fight for
the same orbs.

No build step: the client is ES modules + CDN importmaps; the server is a
single Node process that also serves the client files, so one command runs
everything.

## Run

```bash
cd games/opengame
npm install
npm run serve        # server + client on http://localhost:2567
```

Open **http://localhost:2567 in two browser tabs** to test multiplayer —
both players share one arena, one orb pool, one match, and the same enemies.

Tooling: `npm run check` (node --check on every file) and
`npm run test` (FSM unit test + headless multiplayer/integration test).
For browser-only regressions (schema API misuse, scene wiring errors)
run the Playwright e2e against a running server:
`python3 test/browser.test.py`.

## Controls

| Key | Action |
|-----|--------|
| W / A / S / D or arrows | Move (camera-relative) |
| J | Melee swing (0.8s cooldown, HUD bar) |
| M | Mute / unmute sound |

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
  and starts a new countdown — same room, same players.
- Death mid-match is not game over: click to respawn.

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

## Combat feedback

- J swing: 0.8s cooldown shown as a HUD bar (server enforces it — rapid
  swings are rejected with a log).
- Enemies flash white when hit; dying enemies burst into pooled particles
  (one reused `THREE.Points` object, no geometry per burst).
- Player damage: red screen flash + decaying camera shake (0.3s) + a
  floating damage number.
- Floating damage numbers are pooled HTML divs projected from 3D positions
  each frame (`src/effects/FloatingTextPool.js`).

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

## Layout

```
opengame/
|-- index.html                    # importmap (three) + UMD (colyseus.js) + HUD/overlays
|-- package.json                  # serve / check / test scripts
|-- assets/
|   |-- characters/adventurer.glb # player model (CC0, Quaternius)
|   |-- enemies/orc.glb           # enemy model (CC0, Quaternius)
|   |-- props/tree.glb, rock.glb  # arena props (CC0, Quaternius)
|   |-- credits/                  # metadata.json + credits.csv (licenses)
|-- src/
|   |-- main.js                   # rAF loop, delta clamp, tab-visibility pause
|   |-- config.js                 # client visuals, camera, effects, renderer knobs
|   |-- network.js                # join (with name), input, respawn, playAgain
|   |-- audio/SoundManager.js     # procedural WebAudio synth (no files)
|   |-- effects/
|   |   |-- ParticlePool.js       # pooled THREE.Points burst system
|   |   |-- FloatingTextPool.js   # pooled damage-number divs
|   |-- scenes/GameScene.js       # world, camera rig, match UI, nametags, board
|   |-- entities/
|   |   |-- Player.js             # local controller: input + FSM + effects
|   |   |-- RemotePlayer.js       # lerped view + effects + nametag
|   |   |-- Enemy.js              # visual only — logic is server-side
|   |-- fsm/                      # StateMachine + Idle/Run (termgame API)
|   |-- server/
|   |   |-- index.js              # colyseus Server + express static :2567
|   |   |-- config.js             # SERVER tunables (authoritative numbers)
|   |   |-- schema/StateSchema.js # WorldState/PlayerState/OrbState/...
|   |   |-- rooms/GameRoom.js     # lifecycle + fixed-timestep simulation
|-- test/
|   |-- fsm.test.mjs              # node:assert FSM unit test
|   |-- multiplayer.test.mjs      # headless: lifecycle, sync, power-ups,
|   |                             #   cooldown enforcement, reconnect
```

## Artwork

All models are **CC0 1.0** by Quaternius (downloaded via poly.pizza) —
details, source URLs and licenses in `assets/credits/`. The GLBs ship
skeletal animations (idle/run/attack/hit) played via `THREE.AnimationMixer`.

## What was verified

1. `npm install` succeeds (colyseus 0.17.10, @colyseus/sdk 0.17.43, express 5.2.1 pinned).
2. `npm run check` — every server/client/test file passes `node --check`.
3. `npm run test` — FSM unit test, plus a headless integration test that
   boots the real server and proves, over real WebSockets:
   countdown → playing on first join, movement sync, a power-up pickup
   applying its timed effect, attack-cooldown rejection (second rapid swing
   does not reset the cooldown), two-client visibility, and automatic
   reconnection after a simulated socket drop (same session + state).
4. `npm run serve` + curl: the client HTML loads (200), the matchmake
   endpoint answers (200), the WebSocket upgrade responds (101), and static
   assets (JS modules, GLBs) are served.
