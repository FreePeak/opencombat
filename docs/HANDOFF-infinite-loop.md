# HANDOFF: Infinite Product Loop — Session Continuation Guide

Status: LIVING DOCUMENT · Updated 2026-08-22 after ~36 shipped cycles
(Sessions A/B/C; Q1/Q2 roadmap fully DONE as of cycle 23)
Purpose: ANY new session (fresh start, watchdog respawn, or peer takeover)
can resume the infinite product loop from exactly where this left off.
Read this top-to-bottom before doing anything else.

---

## 1. The mission (verbatim directive)

> Infinite product loop on opencombat: per cycle — recon peers -> pick top
> unclaimed backlog item -> PRD -> TDD implement -> gate green ->
> commit+push+PROGRESS row -> reseed next cycle.
> User directive: never stop until session manually stopped.

- Skill driving the loop: `goal-decomposition` (~/.config/opencode/skills/)
- Persistence: `goal_create`/`todowrite` every cycle; goal file at
  `~/.local/share/opencode/goals/ses_fd8764abcffevUTJ6uRK8TaBZd.json`
  (older session — a NEW session should `goal_create` its own with this
  same objective text, or `goal_adopt` the old one).
- Only call `goal_update complete` if the user cancels. Otherwise keep
  cycling forever.

## 2. The repo (Ashfall)

`/Users/linh.doan/work/harvey/freepeak/games/opencombat` — multiplayer 3D
arena survival in the browser:

- **Server**: Colyseus 0.17, single Node process on :2567, fixed-timestep
  50ms sim, server-authoritative everything.
- **Client**: zero-build Three.js ES modules + importmaps; LocalRoom.js is
  a browser-local fallback sim implementing the same Room API (parity is
  TESTED — every gameplay rule must land in BOTH rooms or a shared module).
- **Rooms**: game (PvE waves), weekly/daily (challenge variants), lobby→arena
  (PvP + spectate), world (chunked open world).
- **Tests**: plain `node:test`, 20+ files; integration tests boot real
  in-process Colyseus servers on ephemeral ports.

## 3. THE critical context: multi-agent shared tree

**Multiple concurrent opencode sessions work in THIS ONE working tree
simultaneously.** They are peers running the same kind of loop (enterprise-
track roadmap items: OIDC, name-guard, admin API, air-gap vendoring, arena
spectate, achievements, checkpoints...). This is normal and productive IF
you follow the protocol that emerged:

1. **Claim via PRD**: write `docs/PRD-<feature>.md` BEFORE implementing;
   check `ls docs/PRD-*` first — an existing PRD claims the feature.
2. **Targeted staging only**: `git add <explicit paths>` — NEVER `git add -A`
   (it sweeps peers' uncommitted work into your commit).
3. **Never edit a file a peer has dirty.** Check `git status --short` before
   every commit. If your needed file carries foreign hunks (diff it against
   what you know you wrote), WAIT for the peer's commit instead of committing
   mixed state — wholesale commits steal their WIP, and partial commits break
   the gate.
4. **Joint landings are normal**: peers sometimes sweep your uncommitted work
   into their commit ("joint shared-tree landing" in their message) and
   credit you. After any landing, re-run the gate to certify the combined
   tree, then continue.
5. **Monitor cadence between cycles**: poll `git log -1 --format=%h` +
   `git status --short` every ~15s up to ~10min for peer landings, then
   audit what landed (see §7).

## 4. Cycle protocol (each iteration)

```
recon peers (git status/log, new docs/PRD-*, CI via `gh run list`)
-> pick top unclaimed item (docs/vampire-survivors-research.md §6 backlog,
   an audit finding, or a deferred polish)
-> write docs/PRD-<feature>.md following repo PRD conventions
   (Problem/Solution/Scope/Out of scope/Acceptance criteria)
-> TDD RED FIRST: failing test pins the contract
-> GREEN: implement (pure shared/sim module + wiring in BOTH GameRoom AND
   LocalRoom — parity by construction)
-> GATE: npm run check && npm test && npm run smoke  (all must be green)
-> LAND: targeted git add of ONLY your paths -> commit -> push origin master
   -> add a row to docs/PROGRESS.md (Status/Commit/Evidence columns)
-> reseed next cycle todos
```

Repo conventions (non-negotiable): red-first TDD, `node:test`, pure modules
in `src/shared/sim/` with NO imports, both-sims wiring, PROGRESS.md row per
merge, README/ARCHITECTURE sync when public surface changes.

## 5. What shipped this session (all landed & pushed)

Full detail lives in `docs/PROGRESS.md` (rows R3-R40 era) +
`docs/vampire-survivors-research.md`. Highlights:

**Session A — meta/social/platform track (docs/PROGRESS.md rows 2.5–2.21):**

| System | Commit(s) |
|---|---|
| Daily Gauntlet (seeded daily challenge, streaks, /api/daily) | b08f14f |
| Elite Affixes (Swift/Bulwark/Vampiric/Volatile every 5th wave) | 78a0c5e |
| Kill Streaks + combat juice (milestone broadcasts, trauma shake, hit-stop) | joint 750844e |
| Presence panel (/api/players, online-now UI, recent allies) | joint b40264f |
| Adaptive Music Director (intensity tiers, quantized crossfades) | 77f1b99 |
| Live Match Browser (/api/rooms, JOIN panel, late-join spawn protection) | joint → 74787e5 |
| Weekly Gauntlet (ISO-week modifier stacks, /api/weekly) | ca95762 |
| Achievements (predicate engine over persisted blob, unlock toasts) | 604cc26 |
| **USER FIX: offline endless war** — LocalRoom({endless:true}) disables targetScore/finale ends; unlimited offline waves | 7bfd9d9 |
| Arena Spectate (seatless joinById spectators, follow-cam, LEAVE pill) | 7ae1d7b |
| OIDC login option (BFF auth-code+PKCE via openid-client, sub→player binding) | 726b4c6 |
| Verified-name join guard (single-use join tickets, 4103 guest rejection) | 5db6c91 |
| Admin API + GDPR rights (token-guarded export/delete + JSONL audit trail) | 3fe1a6a |
| Air-gapped vendoring (VENDORED_ASSETS=1 self-hosted three/schema/sdk) | 31990b9 |
| Stability soak evidence (3x suite + 2x e2e green, zero flakes) | eebb320 |
| Waves spectate + spectator counts (/api/rooms spectators field, 👁N chip) | 701a267 |
| Offline progression checkpoints (localStorage career + personal-best line) | 5ea1919 |
| Objective-Based Weeklies (sticky within-week objective merge, /api/weekly objectives) | 58eb11c |

**Session C — 2026-08-22 continuation (rows 2.22–2.25, R43; all pushed + CI green + peer-audited):**

| System | Commit(s) |
|---|
| Objective-Based Dailies (cycle-18 mirror of weeklies: dailyObjectives LCG picks, sticky .date merge, /api/daily objectives + leaderboard objectivesDone) | 05a49fe |
| Combat Radar (pure projectRadar rim-clamp projection, match-mode HUD canvas) | df77347 |
| Persistence adapter + Postgres driver (PERSISTENCE_DRIVER=postgres preloaded-cache design; sync room reads unchanged; CI postgres service) — LAST roadmap item, Q1/Q2 table now fully DONE | 0149927 |
| Results Share Card (deterministic mode-aware composer, SHARE button clipboard copy on gameover) | b20871f |
| R43 stability soak + perf-gate flake fix (raw max -> p99 + pathology ceiling; soak evidence in row) | 3915f65 |
| Objective HUD (machine-readable {kind,value} targets over the wire, menu goal lines, live in-match [x]/[ ] chip for daily/weekly) | 44d4f63 |

**Session B — PvE content track (rows R3-R40 era):**

| System | Commit(s) |
|---|---|
| VS genre research + ranked backlog | e4956e5 |
| Elite affixes support (spawn/hooks/finish verification) | joint 750844e |
| Shooter archetype + 500ms windup telegraph | 5e63504, 6009c2c |
| Kill-drop charged-orb economy | joint b40264f (PRD b9c85cb) |
| Magnet power-up (orb-field attraction) | 3d42bff |
| Finale arc: co-op victory + full-pool surge + Warlord boss + boss bar + trauma shake | 761d5c8, 4eff0f4, 8268a8a, f888fa0, 89a5da7 |
| Career meta: stats/tints/unlock toasts/persisted baselines/offline parity | f2be3cf, f45a477, d1953aa, 4abf254 |
| Fairness: daily-victory finalize fix, burn-kill attribution, ranged-block pin | 6d0dab9, a6fefe7, 10fb248 |
| Readability: hostile red arrows, gold orbs, pickup chime | 4c605db, 5e374a7 |
| UI fixes: banner z-order x2, toast stagger, weekly fake-streak text, new-best callout | fb4cdfb, 55af191, 77af692, e9d5b2c |
| Stability: perf gate (0.11ms median vs 50ms), double-soak evidence, orb-noise guards x3 | 8595a6d, 1c2ca84, a9dc254, 21cd6bb, 806c04a |
| Docs: README systems section, ARCHITECTURE sim inventory, audit logs | c2ad807, 5003523, 0d1961e |

Peer landings audited compose-clean (see `docs/PRD-career-stats.md` rolling
audit log): weekly gauntlet, presence, spectate x2, achievements, offline
checkpoints, OIDC, name-guard, admin/GDPR delete, air-gap vendoring,
objective-based weeklies.

## 6. In-flight at handoff time

**RESOLVED — nothing in flight (updated after Session C, 2026-08-22).**
The ENTIRE Q1/Q2 roadmap table in docs/PROGRESS.md is DONE, including the
former last open item 2.2 (Postgres adapter, 0149927 — unblocked via local
Homebrew Postgres on an ephemeral port + CI service container; docker not
required). Cycles 18–23 landed clean and peer-audited compose-clean.

Backlog ideas still unclaimed (all diminishing-returns — assess honestly
before claiming):
- Spectate delay / anti-stream-snipe (hard: Colyseus delta sync gives
  spectators full state; a real delay needs server-side snapshot buffering)
- Touch polish (TouchControls.js is COMPLETE — joystick/buttons/edge-detect,
  no TODOs; only claim with a concrete reproducible gap)
- World-mode depth (vague — needs a concrete PRD before it is a cycle)
- Share-card image rendering (canvas PNG of the cycle-21 text card)

Also verify CI after any landing: `gh run list --limit 3` (repo runs two
jobs per push: `verify` = node ci -> check -> test -> smoke, now WITH a
postgres service container running the driver contract tests;
`e2e` = real Chromium browser flow).

## 7. Hard-won pitfalls (DO NOT rediscover these)

1. **D7 pause wall ordering**: a level-up card born from a killing blow
   opens the global pause wall on the NEXT tick — BEFORE wave-clear dispatch
   — freezing the sim mid-clear. Any clear-then-advance test flow must pick
   pendingChoices WHILE racing toward intermission. The wall is GLOBAL
   across all players, and each client must send chooseUpgrade from ITS OWN
   connection (server binds picks to sender sid).
2. **LocalRoom attackCd burns on SIM time** (`_step` dt), never wall time —
   real-time waits cannot expire it; poke `me.attackCd = 0` in tests
   (phase4 precedent).
3. **Rusher-crosses-arc flake**: fast enemies positioned for a fan swing can
   cross BEHIND the arc under event-loop load. Freeze positioned enemies:
   `sr.enemyStunUntil.set(e, Date.now() + 5000)` (or `_enemyStunUntil` +
   performance.now() locally).
4. **Orb-noise in exact score asserts**: roaming orbs spawn at random
   positions and award +10 score on proximity pickup — random placement can
   contaminate exact deltas. Park them (`o.x = 40; o.z = 40`) before any
   exact-equality score assert (guards exist in waves/compose/arena/
   elitesIntegration tests — follow that pattern).
5. **Fan geometry vs melee cone**: the 60° cone fits ~±30°; adaptive spacing
   `Math.min(0.3, 0.9/(n-1))` keeps big fans inside it (surge fields 10).
6. **Missing-module CI breaks**: peers occasionally commit imports without
   their new file (happened twice: weeklyRun.js, achievements.js). Symptom:
   CI boot failure `ERR_MODULE_NOT_FOUND`. Remedy: verify the file exists on
   disk + passes its tests, then land it surgically (or wait — peers often
   self-repair within minutes; check `git log` first to avoid racing).
7. **Late-join grace**: mid-'playing' joins get a 3s invuln window
   (name-guard/live-matches era). Tests asserting instant damage after a
   joinById must wait on `(sr.invulnUntil.get(sid) || 0) <= Date.now()`.
8. **Client mirror vs server state**: in probes/tests, `r.state` is the
   CLIENT-side decoded copy — mutations there are invisible to the server.
   Always mutate `room.state` (the room instance's schema objects).
9. **Shared tree sweeps**: keep your working set always committable (tests
   green per logical unit); assume any uncommitted byte may ride a peer's
   broad commit — that is acceptable IF the gate was green when you last
   verified YOUR content.

## 8. Verification commands

```bash
npm run check          # syntax gate over every src/test file
npm test               # full suite (200+ tests, ~3-4 min)
npm run smoke          # boots prod server, 8 live checks incl WS join
gh run list --limit 3  # hosted CI: verify job + real-browser e2e job
node --test test/<file>.test.mjs   # single file during development
```

Merge habit (per ARCHITECTURE.md §7 / EXPANSION_PLAN.md): red test first →
green → full gate → smoke → targeted commit → push → PROGRESS.md row.

## 9. Key file map

- `src/shared/sim/*.js` — pure parity-critical modules (elites, archetypes,
  orbDrops, magnetPull, careerStats, streaks, combatBook, projectileLoop,
  matchPhases, leveling, shopEffects, dailyRun, weeklyRun, achievements)
- `src/server/rooms/GameRoom.js` + `src/LocalRoom.js` — the TWO sims; every
  gameplay change wires identically into both
- `src/server/schema/StateSchema.js` — synced state classes
- `src/scenes/GameScene.js` — whole client shell
- `docs/PRD-*.md` — feature claims/contracts; `docs/PROGRESS.md` — tracker;
  `docs/ARCHITECTURE.md` §shared/sim table; `docs/vampire-survivors-research.md`
  — genre research + ranked backlog + rolling statuses

## 10. Resume checklist

1. `cd` repo; read this file + tail of `docs/PROGRESS.md`.
2. `git status --short` + `git log --oneline -10`: who landed what while you
   were away? Any dirty files (whose)?
3. `gh run list --limit 3`: is master's CI green?
4. `npm run check && npm test`: certify your base before building.
5. Scan `docs/vampire-survivors-research.md` §6 + new PRDs: claim an
   unclaimed item (write "PLANNED (cycle X)" into its Status column).
6. Run the cycle protocol (§4). Log audits into
   `docs/PRD-career-stats.md`'s rolling section.
7. Never mark the overall goal complete — the directive is infinite until
   the user stops the session.
