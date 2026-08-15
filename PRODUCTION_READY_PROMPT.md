# Production-Ready Prompt — opengame (Three.js + Colyseus arena survival)

Paste the block below into your agent (dsh / Claude Code / opencode). It is
self-contained: context, the known gameplay failures (found by code review),
the production checklist, and the acceptance gates.

---

```text
You are working in /Users/linh.doan/work/harvey/freepeak/games/opengame —
a browser multiplayer 3D arena-survival prototype. Stack: Three.js 0.185
client (ES modules + CDN importmap, NO build step), Colyseus 0.17 server
(Node, plain .js, one process serves both WebSocket and static files on
port 2567). Commands: `npm run serve`, `npm run check`, `npm run test`
(two suites, currently passing). There is NO git repo in this directory —
initialize one only if asked.

The game's gameplay is currently FAILED and the code is not production
ready. Fix both. Do not just patch symptoms — verify each fix by actually
running the server and, where possible, the headless test suite.

## PART 1 — Fix the gameplay bugs (found by reading the code; reproduce
## each one before fixing)

1. GHOST PLAYERS (critical): dead players (hp <= 0) remain fully
   functional. In src/server/rooms/GameRoom.js:
   - movePlayers() moves every player regardless of hp — a dead player
     keeps running around.
   - updatePlaying() orb pickup and power-up pickup iterate all players
     with no hp > 0 check — a dead player keeps collecting orbs and
     scoring, and can even trigger the win condition.
   - Enemy targeting picks the nearest player with no hp check — enemies
     chase and "hit" corpses.
   - onInput() accepts movement and attack from dead players — a ghost
     can swing.
   Fix: dead players are frozen (dirX/dirZ ignored), cannot pick up orbs
   or power-ups, cannot attack, are excluded from enemy targeting, and
   cannot win. Only the respawn click works.

2. ATTACK OUTSIDE THE MATCH (high): onInput() calls melee() with no
   matchState check, so players can swing during COUNTDOWN and even on the
   GAME_OVER screen (killing enemies). Gate attack on matchState ===
   'playing'.

3. RESPAWN LEAK (medium): onRespawn() resets x/z/hp but NOT effects — a
   shield/double/speed buff survives death. Clear player.effects on
   respawn and on play-again reset.

4. JOIN DURING GAME_OVER (medium): a player who joins while
   matchState === 'gameover' is stranded until someone clicks play again.
   Decide and implement: either auto-start a new countdown after a short
   timer when a player joins an empty gameover room, or move them to a
   waiting state clearly shown in the UI. Keep it simple; document the
   choice in the README.

5. WINNER EDGE CASES (low): in timed mode endMatch(null) can fire with no
   players in the room (winnerId = null broadcast). Guard it. Also ensure
   the "play again" reset clears winnerId/winnerName even when a timed
   match ends with all players gone.

6. Client-side cleanup (medium):
   - Add a window resize handler (renderer.setSize + camera aspect) —
       currently the canvas is sized once at construction, so resizing
       the window distorts the view.
   - Detect WebGL support and show a clear error instead of a black
       screen; wrap client boot in a try/catch that surfaces failures in
       the login overlay.
   - Stop serving node_modules/, src/, package.json etc. over HTTP:
       express.static currently exposes the whole game root. Serve only
       index.html + a public assets dir (move or whitelist accordingly,
       keep it minimal — no build step required).

## PART 2 — Production readiness checklist (implement all of it)

Deployment / ops:
- Dockerfile (node:20-alpine or newer LTS, npm ci, EXPOSE 2567, healthcheck)
  + docker-compose.yml (app + optional Redis for presence).
- Environment-driven config: PORT, public URL/WS URL (client must not
  hardcode ws://localhost:2567 — build a config.js fallback chain:
  env > window.location host > localhost), and a flag to disable shadows
  on low-end clients.
- Graceful shutdown: handle SIGTERM/SIGINT (close matchmaker, stop rooms,
  close server) without the current "Error: disposing" noise seen when
  the test tears down.
- /healthz endpoint returning { ok, rooms, players, uptime }.

Scaling / robustness (Colyseus 0.17):
- Presence driver via Redis so the server can run multiple processes
  behind a load balancer (matchmaking + room state across instances).
- maxClients cap per room (e.g. 8-16) so one room cannot be overloaded.
- Empty-room cleanup: dispose rooms with 0 players for N seconds.
- Keep the fixed-timestep loop but compute dt from real elapsed time
  (this.clock.setInterval drift) so effects/simulation stay correct under
  load.

Security:
- Per-IP connection rate limiting (not just per-session input caps) to
  blunt join-flooding; simple in-memory token bucket is fine for now.
- Keep existing input validation (finite dirs, magnitude clamp, name
  sanitization, XSS-safe leaderboard) — add a comment header noting they
  are security boundaries; do not regress them.
- CORS restricted to the app origin; serve assets with sensible
  Cache-Control headers (immutable for versioned assets, no-cache for
  index.html).

Observability:
- Structured logging (pino or plain JSON lines): join/leave, room
  create/dispose, match transitions, rejected inputs — with a sessionId
  field.
- Prometheus-style metrics (prom-client) OR a minimal /metrics endpoint:
  room count, connected players, tick duration, inputs/sec.

Client / UX:
- WebGL support check + graceful error (see Part 1.6).
- Window resize handler (see Part 1.6).
- Loading progress or a timeout error if the GLB models/CDN fail to load
  (currently stuck on "loading…" forever if a CDN is unreachable).
- Keep the zero-build architecture IF it works for the target deploy; if
  you vendor three.js/colyseus locally instead of CDN, do it via
  download-to-assets + importmap rewrite — do not introduce a bundler
  unless there is no other way.

Tests — extend test/multiplayer.test.mjs (and fsm tests if relevant):
- GHOST: player at hp 0 cannot move/collect/score/attack; enemies ignore
  them.
- ATTACK GATE: swing during countdown does no damage; swing during
  playing does.
- RESPAWN: effects cleared, hp restored, spawn invuln set.
- WIN: gameover only via score/timer with living players; play-again
  fully resets state.
- HEALTH: /healthz returns 200 with expected shape.
Keep `npm run test` and `npm run check` green. Run them before finishing.

## Definition of done
1. All Part 1 bugs fixed and covered by tests (ghost, attack gate,
   respawn leak at minimum).
2. Part 2 items implemented; server boots, serves, and passes /healthz.
3. `npm run check` and `npm run test` pass locally.
4. README updated: run instructions (docker + bare), env vars, deploy
   notes (TLS/WSS via reverse proxy), and the design decisions you made
   (join-during-gameover, room cap, presence).
5. Report: a short summary of each bug's root cause + fix, the new
   endpoints, and how to run it in production.
```
