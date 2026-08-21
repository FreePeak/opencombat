# Ashfall (opengame) — Architecture Map

A precise map of how the game fits together, written for a new engineer (or
agent) who needs to navigate it and change it safely. Facts here are verified
against the code on `master`; line references use `file:line` and drift only
if the file changes.

The game: server-authoritative multiplayer 3D arena survival. Three.js
renders; Colyseus owns every outcome. Three modes:

| Mode | Room | Offline fallback |
|------|------|------------------|
| Waves (PvE survival) | `game` -> GameRoom | yes — browser-local `src/LocalRoom.js` |
| PvP Arena (duel/team/ffa) | `lobby` -> ArenaRoom | no |
| Open World (chunked) | `world` -> WorldRoom | no |

---

## 1. System overview

```
                 BROWSER (zero build step: ES modules + CDN importmap)
+--------------------------------------------------------------------------+
| index.html        HUD/overlays, importmap(three), UMD colyseus.js global  |
|                                                                           |
|  src/main.js -------- rAF render loop (dt clamped to 0.05s)               |
|      |                                                                    |
|  src/scenes/GameScene.js --- login/mode picker, entity views, HUD,        |
|      |                      camera rig, upgrade/shop overlays             |
|      |                                                                    |
|      |-- ONLINE path ------------------------------------------------     |
|      |    src/network.js (Colyseus SDK wrapper)                           |
|      |      joinGame() / joinLobby()+sendQueue()+consumeReservation()     |
|      |      joinWorld()                                                   |
|      |                                                                    |
|      +-- OFFLINE fallback (Waves mode only, when probe fails) ----------- |
|           src/LocalRoom.js   <=== consumes the SAME shared sim core ==>   |
|           (rAF-driven tick, dt clamped 0.05s, Colyseus Room API subset)   |
+------------------------------|--------------------------------------------+
                               | WebSocket ws(s)://host:2567
                               v
+--------------------------------------------------------------------------+
| ONE NODE PROCESS — node src/server/index.js (:2567)                       |
|                                                                           |
|  Colyseus Server                                                          |
|   * WebSocketTransport bound to our http.Server; express callback =       |
|     src/server/http.js:                                                   |
|       /healthz  /metrics  /env.js  /__reload (dev SSE live reload)        |
|       static whitelist: / , /assets , /src                                |
|       (/src/server/* locked except StateSchema.js, config.js,             |
|        movement.js — the three modules the browser client imports)        |
|   * rooms registered in src/server/index.js:36-39:                        |
|       'game'  -> GameRoom   waves PvE survival                            |
|       'lobby' -> LobbyRoom  queue -> matchMaker.createRoom('arena')       |
|                              -> reserveSeatFor -> client 'redirect'       |
|       'arena' -> ArenaRoom  duel/team/ffa rounds (+ optional PvE toggle)  |
|       'world' -> WorldRoom  chunked open world, per-name persistence      |
|   * per-room fixed-timestep sim: TICK_MS = 50 (env TICK_MS),              |
|     dt = real elapsed seconds clamped to 0.25                             |
|                                                                           |
|  src/shared/*.js — pure simulation core shared by ALL rooms AND LocalRoom |
|   combat / projectiles / classes / skills / progression / waves /         |
|   arena / worldgen                                                        |
+-------------------------------|-------------------------------------------+
                                | node:fs (WorldRoom only)
                                v
                 data/players/<name>.json   (debounced 2s,
                 atomic write via tmp+rename — src/server/persistence.js)
```

Presence is in-memory by default; set `REDIS_URL` for multi-process
matchmaking (`src/server/index.js:33`). All tunables that affect the
simulation live in `src/server/config.js` (the `SERVER` object), which is
also evaluated in the browser because LocalRoom imports it.

---

## 2. Module map

### Repo root

| Path | Owns |
|------|------|
| `README.md` | run/deploy docs, design decisions, security notes |
| `EXPANSION_PLAN.md` | 7-phase roadmap (Phases 0-6 all DONE) + locked decisions |
| `ARTWORK_PLAN.md` | visual upgrade plan (client-only changes), perf budget |
| `STORY.md` | lore ("Ashfall"); numbers referenced there live in code |
| `index.html` | HUD/overlays DOM, three importmap, colyseus.js UMD, boot watchdog |
| `package.json` | scripts: `serve`, `dev`, `check`, `test`; deps colyseus 0.17/@colyseus/sdk/express |
| `assets/` | GLB models + `credits/` license metadata |
| `data/players/` | per-player JSON saves (created at runtime by WorldRoom) |

### src/ (root)

| File | Owns |
|------|------|
| `src/main.js` | guarded boot: WebGL2 check, rAF loop with dt clamp 0.05s (`main.js:54`), tab-hidden pause, `window.__gameScene` e2e hook |
| `src/config.js` | client-only config: server URL fallback chain (`?server=` > localStorage > `/env.js` wsUrl > same-origin > localhost:2567), renderer knobs (dpr clamp, shadows/bloom gates), character roster GLB/anim mapping |
| `src/network.js` | Colyseus SDK wrapper: `serverAvailable()` raw WS probe, `joinGame/joinWorld/joinLobby/joinArena/consumeReservation/reconnectRoom`, all `send*` intent helpers |
| `src/joinError.js` | dependency-free join-failure message mapping ("too many join attempts" contract) |
| `src/LocalRoom.js` | OFFLINE solo sim (892 lines): a browser-local replacement Room running the same lifecycle/combat via the shared core; mirrors GameRoom bookkeeping (see section 5) |

### src/server/

| File | Owns |
|------|------|
| `server/index.js` | bootstrap: one process serves HTTP + WebSocket on :2567; defines the four rooms (`index.js:36-39`); startup self-check that static serving actually mounted (`index.js:47-55`); graceful shutdown log hook |
| `server/config.js` | `SERVER` tunables — authoritative gameplay numbers + deployment env overrides. Key blocks: `tickMs` (line 30), `world` (35), `persistence` (44), `match` lifecycle (52), `player` combat numbers (62), `wave` (98), `enemy` (103), `powerUps` (125), `projectile` (136), `progression` (155), `characters.count` (163), `arena` (166), `lobby` (179), security `net`/`rateLimit` (188-197) |
| `server/http.js` | express app factory on top of the transport's app: `/healthz` (88), Prometheus-style `/metrics` (93), `/env.js` injection (122), dev SSE `/__reload` (137), restricted CORS, whitelisted static serving with the `/src/server` lock list `clientReachable` (158-162); `attachHttpLogging` sees even `/matchmake*` requests |
| `server/log.js` | JSON-lines structured logging (`log`/`warn`/`error`) |
| `server/ratelimit.js` | per-IP token bucket for joins (`takeToken`/`normalizeIp`/`resetRateLimit`). Lives in room `onAuth` because Colyseus 0.17 routes `/matchmake*` through its own dispatcher, bypassing express middleware entirely |
| `server/movement.js` | pure `stepPlayer()` — position integration used by GameRoom/ArenaRoom/WorldRoom AND LocalRoom; movement is never blocked by attacking (RC7) |
| `server/persistence.js` | `loadPlayer` / `savePlayerDebounced` (2s debounce, atomic tmp+rename) / `flushAll`; filename = sanitized player name |
| `server/liveReload.js` | dev-only SSE hub watching client files (src/ minus src/server/, assets/, index.html); off under NODE_ENV=production or LIVE_RELOAD=0 |
| `server/schema/StateSchema.js` | wire format via `defineTypes` (no decorators): `PlayerState` (x/z/rotY/hp/score/anim/name/character/color/effects/attackCd/skillCd/blocking/level/xp/pendingChoices/upgrades/team), `OrbState`, `PowerUpState`, `EnemyState`, `ProjectileState`, `WorldState` (players/orbs/enemies/powerUps/projectiles + `matchState`: lobby\|countdown\|playing\|intermission\|gameover at line 143 + countdown/wave/winner/paused/intermissionUntil/arena* fields), `LobbyState` |

### src/server/rooms/

| File | Owns |
|------|------|
| `rooms/GameRoom.js` | Waves survival (1330 lines). Lifecycle LOBBY->COUNTDOWN->PLAYING->INTERMISSION->GAME_OVER; fixed-timestep loop (`GameRoom.js:103-111`); wave activation `spawnWave` (156); progression block XP/cards/auto-pick (303-441); intermission shop (538); input validation + attack gate + cooldowns `onInput` (602); respawn (690); damage pipeline `damagePlayer` (736)/`hitEnemy` (768)/`melee` (798)/`castSkill` (827); projectiles `spawnProjectile` (926)/`updateProjectiles` (953); phase dispatch `update(dt)` (1010) incl. pause wall (1026-1056); pickups (1222); win conditions (1277); effects + burn DoT (1305). Security boundaries documented in header: input direction validated, 30 msg/s cap, per-IP onAuth bucket |
| `rooms/LobbyRoom.js` | PvP staging (236 lines): queue map keyed by session, `processQueue` every 500ms groups by `mode:pve:roundsToWin` (153-185), then `createArenaForBatch` mints an ArenaRoom via `matchMaker.createRoom` and sends each player a seat reservation through `'redirect'` (188-235). No simulation |
| `rooms/ArenaRoom.js` | PvP arena (1418 lines): duel/team/ffa from onCreate options (49-55); team assignment (280); friendly-fire gate (735); PvP kill award (745); round-based win conditions using `shared/arena.js` helpers (1296-1338); `resetRound` keeps level/xp/upgrades within a match (1341). Otherwise mirrors GameRoom's skeleton (~80% duplicated — see section 5) |
| `rooms/WorldRoom.js` | Open world (991 lines): always `playing`, seed 1337 (`WorldRoom.js:44`), effectively unbounded (`half = 5000`, line 47); per-tick chunk streaming `updatePlayerChunks` sends `chunksLoad` payloads generated by `shared/worldgen.js` (326-348); loaded-chunk union maintenance (350-372); persistence load-on-join (205-236) / debounced save on leave+dispose+XP events (`persistPlayer`, 306); level-scaled enemy respawn (144); NOTE `state.wave` is repurposed as loaded-chunk count for debug (371) |

### src/shared/ (the parity-critical core)

| File | Owns |
|------|------|
| `shared/combat.js` | pure combat math both sims consume: `facingVector`, `inArc`, `meleeHits`, `blockedHit`, `strikeEnemy`, `strikePlayer`. Rooms keep anim/stun timers, invuln windows, kill score, logs |
| `shared/projectiles.js` | pure projectile math: `stepProjectile`, `projectileExpired`, `projectileHitsTarget` + hit-resolution wrappers over combat.js |
| `shared/classes.js` | `attackFor(character)` — knight melee; archer arrow / mage fireball / demon lightning using `SERVER.projectile` numbers |
| `shared/skills.js` | per-class skill defs (bash/multishot/firewave/chainlight), `CLASS_STATS` base hp/speed/damage, `classStats`, and `resolveSkillHits` dispatcher returning `{hits, projectiles?, movement?, damagePerHit?}` |
| `shared/progression.js` | XP curve `xpForLevel`, ~16-entry `UPGRADES` pool, seeded `rollUpgrades` (LCG shuffle), `aggregateBonuses`, all `effective*` stat helpers, `AUTO_PICK_MS = 10000` |
| `shared/waves.js` | `waveEnemyCount(n)`, `waveEnemyHp(n)` ramps + `spawnAwayFromPlayers` best-of-8 sampling |
| `shared/worldgen.js` | deterministic chunk generation: CHUNK_SIZE 32, 3 biomes, `generateChunk(cx,cz,seed)` (props/spawnPoints/grass via seeded LCG), `activeChunksForPos`, `diffChunks`, `enemiesForLevel` |
| `shared/arena.js` | arena-mode sanitizers, `assignTeams`, `scoresByTeam`, `roundWinner`, `matchWinner`, min/max players per mode |

### src/ client directories

| Directory/File | Owns |
|------|------|
| `anim/AnimUtils.js` | render-math contracts RC1-RC5: strip baked root motion, attack clip time-scale, input-edge survival across the send throttle, frame-rate-correct lerp damping, fixed camera azimuth; knight subclip trimming |
| `audio/SoundManager.js` | procedural WebAudio synth (zero files); init on first user gesture; mute/volume in localStorage |
| `client/NatureDressing.js` | scatters downloaded GLB ground cover (grass tufts, flowers, bushes) across the bounded arena as instanced draws; own LCG stream (seed 9021), fail-soft, called from `src/main.js:45` |
| `client/ChunkManager.js` | open-world chunk streaming (radius 2), InstancedMesh per prop type, deterministic via `shared/worldgen.js` |
| `client/Grass.js` | vertex-colored geometry builders (tuft/tree/dead tree/rock) shared by arena dressing and chunk streaming |
| `effects/ParticlePool.js` | pooled THREE.Points burst system (one buffer, shader fade) |
| `effects/FloatingTextPool.js` | pooled damage-number divs re-projected per frame |
| `effects/SkillFx.js` | cosmetic cast visuals: sword slash arc, bash ring, chain-lightning arcs |
| `entities/Player.js` | local controller view: SkeletonUtils clone, Idle/Run FSM, throttled input intents, effect visuals |
| `entities/RemotePlayer.js` | lerped remote view + effects + skill-fx edges |
| `entities/Enemy.js` | visual-only enemy (logic is server-side) + billboard HP bar |
| `entities/Sword.js` | weapon attachment to hand bones + procedural animation fallback for the clip-less knight rig |
| `fsm/StateMachine.js` (+ `states/IdleState.js`, `states/RunState.js`) | tiny generic FSM, Node-testable, termgame API |
| `scenes/GameScene.js` | the whole client shell (1388 lines): login/mode picker (`MODES` at 34-38), model loading with timeout guard, room wiring + entity add/remove, HUD/overlays (countdown, leaderboard, nametags, upgrade cards, shop, gameover/death/intermission popup), fixed-azimuth camera rig, projectile views, open-world visual swap `enterWorldVisuals` (374), disconnect/reconnect handling, LocalRoom fallback branch in `onJoinClick` (307-327), PvP lobby flow `joinPvpLobby` (351) |
| `scenes/WorldScene.js` | standalone open-world renderer (chunk stream + minimap + camera follow). The main flow uses GameScene's world mode instead; kept as an alternative composition |
| `tools/assetPipeline.js` | pure asset-pipeline logic (plan downloads, validate GLB, safe output paths, resolve source URLs) consumed by `tools/fetch-assets.mjs`; unit-tested without network |
| `tools/scatter.js` | LCG placement sampler (makeLcg/sampleOpenPositions/fitScale) consumed by `client/NatureDressing.js` and pinned by its own unit test |
| `tools/zipExtract.js` | minimal ZIP reader (stored/deflate) used by assetPipeline for pinned Kenney packs |
| `ui/Minimap.js` | canvas minimap: biome-tinted chunks + player dots |
| `ui/TouchControls.js` | mobile overlay: floating joystick + action buttons; `stickAxes` dead-zone math is pure and unit-tested |

### tools/ (repo-level tooling)

| File | Owns |
|------|------|
| `tools/check.mjs` | syntax gate: `node --check` over everything under src/** and test/** (auto-globbing) — `npm run check` |
| `tools/fetch-assets.mjs` | manifest-driven asset downloader (network layer); imports the PURE logic from `src/tools/assetPipeline.js` so tests never touch sockets |
| `tools/mixamo_to_glb.py` | Blender-headless Mixamo FBX pack -> single game-ready GLB converter |
| `tools/asset-manifest.json` | download manifest data for fetch-assets |

Not duplication: `tools/fetch-assets.mjs` (I/O + HTTP) vs `src/tools/assetPipeline.js`
(pure planning/validation) is a deliberate split so the pipeline is testable
offline.

---

## 3. Data flow

### Join

1. Login screen (`index.html` + `GameScene.init`). While the player types,
   `serverAvailable()` probes the target host with a raw WebSocket handshake
   (`network.js:32-54`).
2. On JOIN click, `onJoinClick` loads models (15s timeout guard), re-probes if
   a typed server differs, then branches by mode (`GameScene.js:307-327`):
   - `waves` + online -> `joinGame(name, character)` (joinOrCreate `game`)
   - `waves` + offline -> `new LocalRoom().join(...)` + "OFFLINE - SOLO MODE" badge
   - `pvp` -> `joinPvpLobby()` (`GameScene.js:351`): joinOrCreate `lobby`,
     send `queue {mode,pve,roundsToWin}`, await `'redirect'` reservation,
     leave lobby with close code 4000, `consumeReservation(reservation)`
   - `world` -> `enterWorldVisuals()` + `joinWorld(...)`
3. Server-side join path per room: `onAuth` (per-IP token bucket) ->
   `onJoin` (sanitize name/character, create-or-reconnect PlayerState) ->
   state patches flow to every client.
4. Reconnect: unexpected drops hold the seat via `allowReconnection` for
   `SERVER.match.reconnectGraceMs` (15s); the client retries with its
   reconnection token and falls back to a fresh join if the seat expired.

### Match lifecycle (GameRoom; clients only render)

```
LOBBY --first join (minPlayers=1)--> COUNTDOWN(3s) --> PLAYING
  PLAYING --all wave enemies dead--> INTERMISSION (invulnerable, shop,
            auto-advance after 8s or any player's nextWave click)
  INTERMISSION --> COUNTDOWN(next wave) --> PLAYING ...
  PLAYING --score>=100 or timer--> GAME_OVER --> playAgain/resetMatch --> COUNTDOWN
```

Transitions happen only inside the room (`startCountdown`/`startPlaying`/
`endMatch`/`resetMatch`, `GameRoom.js:444-520`). Attacks are gated to
`playing` server-side (`onInput`, 643-669). Dead players are ghosts: input
rejected, excluded from targeting/win checks until they click respawn.

### Tick loop (fixed timestep)

```js
// every room, e.g. GameRoom.js:103-111
this.clock.setInterval(() => {
  const dt = Math.min((now - this.lastTickAt) / 1000, 0.25); // REAL elapsed, clamped
  this.update(dt);
}, SERVER.tickMs);   // TICK_MS = 50 (env TICK_MS)
```

- Interval cadence is 50ms but integration uses real elapsed time (clock-drift
  compensation under GC/load); the 0.25s clamp prevents teleporting after a stall.
- `update(dt)` dispatches by `matchState` (lobby/countdown/playing/intermission/
  gameover). `updatePlaying` runs: scheduled melee impacts -> movement ->
  effect/burn timers -> pickups -> projectiles -> enemy AI (nearest living
  target, hit-stun, contact damage) -> wave-clear check -> win conditions.
- Pause wall: while any living player has pending upgrade cards the world dt
  goes to 0 (auto-pick deadline still ticks; capped by `wave.maxPauseMs`),
  except score-win evaluation continues so progression cannot deadlock wins.
- Client render loop is separate: `main.js` rAF with dt clamped to 0.05s;
  LocalRoom runs the same clamp in `_tick` (`LocalRoom.js:202`). Entities lerp
  toward authoritative x/z/rotY; the render loop pauses when the tab hides.

### Input -> state -> render

1. Keyboard/touch -> `Player.update` maps WASD onto the FIXED camera azimuth
   (RC5), edge-detects J/K presses (`shouldSendInput` survives the ~30Hz send
   throttle).
2. `sendInput(room, dirX, dirZ, attack, skill, anim, block)` — positions are
   NEVER sent; only a unit-ish direction (server validates finite + magnitude
   <= 1) plus edge-triggered flags and held `block`.
3. Server mutates `WorldState`; Colyseus patches broadcast ~20Hz.
4. `GameScene.wireState` creates pooled entity views once; per-frame they lerp
   toward state. HUD/overlays read `matchState`, `countdown`, cooldown fields,
   `pendingChoices`, `effects`.

Message vocabulary (room <-> client): `input`, `respawn`, `playAgain`,
`nextWave`, `chooseUpgrade`, `chooseShop` (up); `blocked`, `levelUp`,
`upgradeResult`, `shopResult`, `redirect`, `queued`, `chunksLoad` (down).

Open world adds: WorldRoom streams `chunksLoad {chunks}` per newly visible
chunk; the client renders them deterministically via ChunkManager (same seed),
so chunk CONTENT is never synced — only the trigger message.

---

## 4. Shared-core contract (offline parity is tested)

Both GameRoom (authoritative) and LocalRoom (browser solo) import the same
modules; neither may fork the rules:

| Shared module | Consumed by | What it pins |
|---------------|-------------|--------------|
| `shared/combat.js` | GameRoom, LocalRoom (also ArenaRoom, WorldRoom) | arc reach, block hemisphere, knockback strikes |
| `shared/projectiles.js` | GameRoom, LocalRoom (also ArenaRoom, WorldRoom) | movement, TTL/bounds expiry, collision radius |
| `shared/classes.js` | GameRoom, LocalRoom (also ArenaRoom, WorldRoom) | who fires what normal attack |
| `shared/skills.js` | GameRoom, LocalRoom (also ArenaRoom, WorldRoom) + Player.js/RemotePlayer.js | skill shapes, CLASS_STATS, cooldowns |
| `shared/progression.js` | GameRoom, LocalRoom (also ArenaRoom, WorldRoom) + HUD | XP curve, card pool, seeded rolls, effective stats |
| `shared/waves.js` | GameRoom, LocalRoom (also ArenaRoom) | wave counts/hp ramp, spawn-away-from-players |
| `shared/worldgen.js` | WorldRoom, ChunkManager/Minimap | identical chunks without syncing content |
| `shared/arena.js` | LobbyRoom, ArenaRoom + client | modes, teams, round/match winners |

Test files that enforce parity between the two sims (run by `npm test`):

- `test/combatShared.test.mjs` — pins combat.js against real SERVER tunables.
- `test/combat.test.mjs` — Part 2 replays the same combat rules against LocalRoom deterministically.
- `test/waves.test.mjs` — LocalRoom wave-flow parity block (intermission, invulnerability, next-wave).
- `test/phase3.test.mjs` — LocalRoom bash-dash/stun integration.
- `test/phase4.test.mjs` — same XP sequence produces identical level/card choices in both sims.
- `test/projectiles.test.mjs` — LocalRoom spawns typed ProjectileState and flies/hits like the server.
- `test/multiplayer.test.mjs` — also guards the `/src/server` static whitelist
  (StateSchema/config/movement must stay reachable or the offline import chain breaks).

Rule of thumb: gameplay math goes in `src/shared/*.js` (pure, unit-tested);
per-room bookkeeping stays in the rooms. Anything edited in GameRoom must be
checked for a mirrored block in LocalRoom (section 5) and vice versa — the
parity tests above will catch most, but not all, drift.

---

## 5. Duplication inventory

### 5.1 GameRoom.js vs LocalRoom.js (mirrored blocks, verified)

| # | Logic | GameRoom.js | LocalRoom.js | Rating |
|---|-------|-------------|--------------|--------|
| D1 | Wave activation over the fixed enemy pool | `spawnWave` 156-175 | `_spawnWave` 209-228 | SAFE-TO-EXTRACT (math already in waves.js; only the apply-to-state loop is mirrored) |
| D2 | Progression bookkeeping: XP grant, level-up queue, seeded card roll, auto-pick deadline, manual pick | `grantXp/maybeLevelUp/showNextQueued/hashSeed/applyUpgrade/checkAutoPicks/onChooseUpgrade` 303-441 | `_grantXp/_maybeLevelUp/_showNextQueued/_hashSeed/_applyUpgrade/_checkAutoPicks/_chooseUpgrade` 233-323 | SAFE-TO-EXTRACT (pure parts already in progression.js; remainder differs only by clock source and client.send vs _emitMessage) |
| D3 | Intermission shop effects (heal/speed/vitality formulas) | `onChooseShop` 538-575 | `_applyShop` 84-107 | SAFE-TO-EXTRACT |
| D4 | Burn DoT setup + tick | setup 976-986 + tick 1315-1328 | setup 731-741 + tick 452-465 | SAFE-TO-EXTRACT (inject a now() fn; Date.now vs performance.now is the only difference) |
| D5 | Enemy-hit resolution (kill score+XP, survivor hit-stun + anim) | `hitEnemy` 768-789 | `_hitEnemy` 596-611 | SAFE-TO-EXTRACT (pass a log callback) |
| D6 | Projectile step/collide/remove loop incl. burn handoff | `updateProjectiles` 953-1007 | `_updateProjectiles` 712-760 | SAFE-TO-EXTRACT (pure math already shared; this is the room-level loop) |
| D7 | Pause wall + auto-pick-before-pause + intermission-deadline extension | `update()` 1026-1056 | `_step()` 330-356 | SAFE-TO-EXTRACT |
| D8 | Match reset (players/orbs/powerups/wave back to fresh) | `resetMatch` 471-520 | `_resetMatch` 829-879 | SAFE-TO-EXTRACT (mostly mechanical) |
| D9 | Skill cast resolution: bash displacement clamp, direct hits w/ decay, projectile spawning, burn tracking | `castSkill` 827-919 | `_resolveSkill` 624-685 | RISKY (GameRoom adds PvP pre-resolution + per-class skillPvpDamage that LocalRoom lacks; parameterize before merging) |
| D10 | Orb pickup + XP | orbs in `updatePickups` 1222-1242 | orbs block 537-554 | RISKY — ALREADY DRIFTED: GameRoom hit test is `dist < orb.radius * pickupMult`; LocalRoom uses `orb.radius*mult + player.radius`, and grants XP only to the local player. Extracting requires picking one rule first (phase4/waves parity tests pin current behavior) |
| D11 | Power-up pickup + delayed respawn | tick-driven `powerUpTimers` map 1244-1273 | `setTimeout` respawn 556-579 | RISKY (structural difference: setTimeout ignores pause/tab-hide; radius drift same as D10) |
| D12 | Player-damage resolution order | `damagePlayer` 736-759: invuln -> playing-gate -> block -> shield -> strike(knockback 0.15x cfg) | `_damagePlayer` 765-788: playing-gate -> block -> shield -> invuln(_lastHit stamp) -> strike(knockback 0) | RISKY (ordering differs; LocalRoom knockback 0 is documented intentional in combat.js:84-86) |
| D13 | Respawn | `onRespawn` 690-709: random pos, full hp, effects cleared, 1s invuln, cooldown scratch reset | `_requestRespawn` 800-812: resets to origin (0,0), NO invulnerability window | RISKY (behavior drift; extraction must reconcile) |
| D14 | Melee impact scheduling (damage lands mid-swing) | push 666 / drain 1141-1146 | push 423 / drain 382-392 | LEAVE (a few lines each side; not worth a seam) |
| D15 | Movement speed composition (class speed x upgrades x block x speed-effect) | `movePlayers` 1102-1105 | 403-405 | LEAVE (3-line formula; cooldown mechanics intentionally differ: server computes from attackAt maps + broadcasts attackCd, LocalRoom decrements fields) |

Extraction order recommendation: D2, D3, D4, D5, D6, D7 first (pure wins,
parity-tested today); D10-D13 only after reconciling the noted drift with a
deliberate decision + updated parity assertions; D14-D15 stay.

### 5.2 The bigger duplication: server rooms

ArenaRoom.js (1418 lines) duplicates roughly 80% of GameRoom.js (1330 lines):
identical method skeletons (verified by method listing) — spawnOrbs/spawnWave/
onAuth/damagePlayer/hitEnemy/melee/castSkill/updateProjectiles/updateEffects/
movePlayers are near-verbatim copies, differing mainly in rounds/teams/friendly
fire and the absence of the intermission shop. WorldRoom.js (991 lines) again
mirrors movePlayers (817-844) and updateEffects (1393-1417 there) plus the whole
input/cooldown scaffolding. Net effect: core sim logic exists in FOUR copies
(GameRoom, ArenaRoom, WorldRoom, LocalRoom). Any rule change today is up to
quad-maintenance; the shared/ modules cover only the pure math. A future
"BaseCombatRoom" extraction would collapse D1-D13 across all rooms, not just
LocalRoom.

### 5.3 tools/ vs src/tools/

| Item | Purpose | Still needed? |
|------|---------|---------------|
| `tools/check.mjs` | `npm run check` syntax gate (globbing) | yes — part of CI habit |
| `tools/fetch-assets.mjs` | network downloader for new assets | yes when adding assets; imports pure logic from below |
| `src/tools/assetPipeline.js` | pure pipeline logic (plan/validate/paths/URL resolve) | yes — consumed by fetch-assets + two test files |
| `src/tools/zipExtract.js` | ZIP reader for Kenney packs | yes — imported by assetPipeline |
| `tools/mixamo_to_glb.py` | Blender FBX->GLB conversion | niche; needed only for knight re-export (locked decision) |
| `tools/asset-manifest.json` | downloader manifest data | pairs with fetch-assets |
| `src/tools/scatter.js` | LCG placement sampler | yes — consumed by `src/client/NatureDressing.js` (GLB ground-cover dressing wired in `src/main.js:45`) and unit-tested by `test/scatter.test.mjs` |

### 5.4 Redundant/one-off scripts in test/

| Item | Purpose | Still needed? |
|------|---------|---------------|
| `test/browser.test.py` | Playwright e2e vs a running server: catches browser-only wiring errors node tests cannot see | YES — keep; run manually per README |
| `test/fixproof.py` | one-off headless proof of RC5 (camera azimuth), RC6 (attack root), skill press against live server+client; screenshots into test/shots/ | historical; superseded by strafeRootSkill.test.mjs contracts. Delete candidate |
| `test/shotproof.py` | one-off screenshot + numeric proof of RC1 (hips slide) and RC2 (attack timeScale) | historical; superseded by movementAttack.test.mjs. Delete candidate |
| `test/burstprobe.py` | frame-delta probe proving the knight swing is visually distinct; wrote attack_peak.png | historical one-off. Delete candidate |
| `test/shots/*.png` (8 files) | committed outputs of those probes | evidence only; nothing consumes them. Delete candidate alongside the probes |

---

## 6. Extension points

Where new things plug in:

- **New room/game mode**: create `src/server/rooms/XRoom.js` following the
  GameRoom pattern (onAuth token bucket, `static instances/stats`, fixed-
  timestep interval, schema state). Then:
  1. register `gameServer.define('x', XRoom)` in `src/server/index.js:36-39`;
  2. add it to `liveRooms()` + `/metrics` in `src/server/http.js:45-53,93-119`;
  3. add a join helper in `src/network.js`;
  4. optionally add a login-screen entry in `MODES` (`src/scenes/GameScene.js:34-38`)
     plus a branch in `onJoinClick` (307-327); set `offline:false` unless you
     also build a LocalRoom mirror.
- **New playable class** (config-driven, 4 places): append to
  `CONFIG.characters` (`src/config.js:160-221` — file/scale/anims/subclips);
  bump `SERVER.characters.count` (`src/server/config.js:163`); add a
  `CLASS_STATS` entry (`src/shared/skills.js:79-106`); add an `attackFor` case
  (`src/shared/classes.js`). Skill-specific upgrades ride `forClass` in UPGRADES.
- **New upgrade card** (config-driven, 2 places): append `{id,name,desc,
  maxStacks,kind,forClass?,bonuses}` to `UPGRADES` (`src/shared/progression.js:52-72`);
  add bonus keys to `aggregateBonuses` zero-init (149) and consume them in an
  `effective*` helper or an `effectiveSkill` branch (239-256).
- **New skill**: `SKILLS` def (`skills.js:40-68`) + resolver function +
  dispatch arm in `resolveSkillHits` (209); VFX in `src/effects/SkillFx.js`;
  anim clip mapping in `CONFIG.characters[].anims.skill`; remote cast triggers
  fire off the anim EDGE in `GameScene.update`.
- **New projectile kind**: numbers in `SERVER.projectile` (`src/server/config.js:136-148`),
  visuals in `CONFIG.projectiles` (`src/config.js:146-150`), projKind mapping
  in `attackFor` or the skill resolver.
- **New arena mode**: `ARENA_MODES` + sanitize/min/max helpers in
  `src/shared/arena.js`; limits in `SERVER.arena` (`config.js:166-176`);
  scoring tweaks go through `roundWinner`.
- **Wave/enemy tuning**: `SERVER.enemy` + `shared/waves.js` — both sims inherit
  automatically.
- **World content/biome**: densities in `generateChunk` (`shared/worldgen.js`),
  BIOMES list, per-biome tints/geometries in `ChunkManager`/`Grass.js`.
- **Persistence fields**: saved snapshot in `WorldRoom.persistPlayer`
  (`WorldRoom.js:306-318`), restore block in its `onJoin` (205-236), filename
  rules in `src/server/persistence.js` `safeName`.

Security boundaries to preserve while extending: input validation + rate caps
(`onInput`), per-IP join bucket (`onAuth`), name sanitization, static-file
whitelist (`http.js` clientReachable), leaderboard HTML escaping client-side.

---

## 7. Test strategy

Run everything from the repo root.

| Command | What it does |
|---------|--------------|
| `npm run check` | `node --check` on every JS/MJS under src/** and test/** via `tools/check.mjs` — the syntax gate |
| `npm test` | `node --test "test/*.test.mjs"` — 17 files, 39 tests (verified green on master) |
| `python3 test/browser.test.py` | Playwright e2e against a RUNNING server; catches scene-wiring/schema-API errors node tests miss (needs `pip install playwright && playwright install chromium`) |

Live server + smoke:

```bash
npm install
npm run serve          # http://localhost:2567 (server + static client, one port)
# or: npm run dev      # same + node --watch restarts + SSE page reload
curl -s http://localhost:2567/healthz     # {"ok":true,rooms:N,players:N,...}
curl -s http://localhost:2567/metrics     # opengame_rooms / players / tick_ms / inputs_per_sec
```

Then open http://localhost:2567 in TWO tabs: both players share one arena,
orbs, enemies and match. The second tab exercises matchmaking visibility,
PvP damage and the shared leaderboard. For PvP Arena you need two tabs queued
in the lobby; for Open World watch `data/players/<name>.json` appear ~2s
after leaving.

What the 17 node test files cover:

| Test file | Coverage |
|-----------|----------|
| `fsm.test.mjs` | StateMachine Idle/Run transitions (pure unit) |
| `multiplayer.test.mjs` | boots a REAL Colyseus server in-process + real SDK clients: lifecycle, movement sync, power-ups, cooldowns, two-client visibility, reconnect, GHOST rules, ATTACK GATE, RESPAWN, WIN/play-again/join-during-gameover, BLOCK, PVP, KILL-UNTIL-DEATH, MOVE+ATTACK, /healthz /metrics /static whitelist |
| `combat.test.mjs` | all-class kills (J/K), move+attack, block negation, PvP damage; Part 2 = LocalRoom deterministic mirror |
| `combatShared.test.mjs` | shared combat math contract vs SERVER tunables (arc/block/knockback) |
| `waves.test.mjs` | wave counts/hp ramp, dead-stays-dead, intermission invulnerability + nextWave gating, hit-stun, play-again reset; LocalRoom parity |
| `phase3.test.mjs` | per-class signature skills + base stats; LocalRoom bash dash/stun integration |
| `phase4.test.mjs` | XP -> level -> 3 cards -> manual/10s auto pick, upgrade effects, reset clears progression; LocalRoom parity |
| `progression.test.mjs` | pure math: xp curve, seeded rollUpgrades, aggregate bonuses, effective helpers |
| `projectiles.test.mjs` | projectile math contract + LocalRoom integration (typed ProjectileState required — plain objects crash the schema encoder) |
| `arena.test.mjs` | LobbyRoom queue->create->reserve->redirect; ArenaRoom duel/team/ffa rounds, team assignment, friendly-fire gate |
| `world.test.mjs` | worldgen determinism, chunk streaming messages, JSON persistence round-trip |
| `movementAttack.test.mjs` | AnimUtils contracts RC1-RC4 (root motion strip, attack time-scale, input edge survival, damped lerp) |
| `strafeRootSkill.test.mjs` | RC5 fixed camera azimuth/strafe + skill system contracts |
| `touch.test.mjs` | TouchControls.stickAxes dead-zone/radius math (pure) |
| `asset-pipeline.test.mjs` | assetPipeline pure logic (planDownloads, validateGlb, safeOutPath...) |
| `asset-pipeline-direct.test.mjs` | pinned direct CDN URL passthrough |
| `scatter.test.mjs` | LCG scatter determinism (covers the orphaned src/tools/scatter.js) |

Testing conventions worth keeping:
- Integration tests boot the real server in-process on an ephemeral port
  (pattern: `test/multiplayer.test.mjs`) and reach authoritative state via
  `RoomClass.instances` / `RoomClass.stats`.
- Rate-limit buckets are reset between scenarios via `resetRateLimit()`.
- Any new gameplay rule gets a shared-core unit test FIRST (red), then the
  room wiring, keeping `npm run check && npm test` green per EXPANSION_PLAN.md.
