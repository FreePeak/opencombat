# Ashfall — Product Requirements Document

Status: Draft v1 (2026-08-22)
Owner: Ashfall maintainers
Related: docs/ROADMAP.md (delivery plan), docs/PROGRESS.md (tracking), docs/COMPETITORS.md (market evidence), docs/ARCHITECTURE.md (technical ground truth)

---

## 1. Vision & Problem Statement

**Vision.** Ashfall is an open-source, server-authoritative multiplayer 3D arena-survivor game that runs in any modern browser tab and is packaged for organizations to brand, embed, host, and extend. We want to be the "shipped game" that sits in the empty center of four failing rings: frameworks nobody can play (Colyseus, Nakama, Agones), games nobody can buy (demo-grade OSS clones), engagement platforms without real gameplay (Kahoot, WorkAdventure, ClassQuiz, Razzia), and proprietary SaaS that forbids self-hosting (Gather.town). One Docker container on :2567 serves client and game together; one iframe snippet embeds a branded match into any marketing page or event screen; every outcome is computed on the server so branded competitions with real prizes are defensible.

**Problem statement.** B2B engagement buyers (events, marketing mini-games, team building) currently choose between quiz-tier interactivity at premium per-seat prices and infrastructure projects that require funding a dev team before anything is playable. Indie devs who want to self-host a complete multiplayer game find framework plumbing, not a product. No OSS project today ships all five of: real-time 3D skill-based play, server authority, zero-install browser delivery, clean commercial license, and ops hooks (health/metrics/Docker). Ashfall closes that gap — but three procurement blockers stand between the current codebase and enterprise approval: no top-level LICENSE file, file-based persistence with no admin/data-subject tooling, and unverified scale-out behavior. This PRD defines what must be true for those blockers to fall.

## 2. Target Customers & Personas

### 2a. Startup founder — embeddable branded game

A growth/marketing-tech founder who wants an interactive branded mini-game embedded in campaign landing pages, lead-gen funnels, or a client's site, without building netcode.

Jobs-to-be-done:
- When I run a campaign, I want to paste one script tag / iframe with my logo and colors so visitors play *my* branded game, not someone else's.
- When a visitor finishes a match, I want their score reported back to my page (postMessage/webhook) so I can gate a prize draw or leaderboard on it.
- When legal reviews my stack, I need a permissive license and no resale restrictions so embedding Ashfall in a paid service is lawful.
- When traffic spikes during a launch, I need health checks and metrics my monitoring can consume.

### 2b. Enterprise event / team-building organizer

An internal-events, HR, or agency organizer running conferences, offsites, booth activations, and team-building sessions for 20–500 attendees.

Jobs-to-be-done:
- When I plan a team-building slot, I want skill-based 3D competition (not another multiple-choice quiz) projected on a big screen with teams joining from laptops or phones via QR code.
- When security reviews the vendor, I want OIDC/SSO sign-in options, documented metrics, restricted CORS, rate limiting, and a data-processing story (minimal personal data, deletion path) so approval does not stall.
- When finance reviews the vendor, I want a self-host option with flat cost instead of per-seat SaaS pricing (the Gather.town/Kahoot pain).
- When the event ends, I want attendee game data exportable and deletable to satisfy GDPR.

### 2c. Indie dev / self-hoster

A solo developer or small community operator who wants a complete, running multiplayer game they can deploy, read, modify, and learn from.

Jobs-to-be-done:
- When I clone the repo, I want `docker compose up` (or `npm run serve`) to give me a playable game on :2567 in minutes, not a framework I must finish.
- When I want to add a class, card, skill, arena mode, or biome, I want config-driven extension points documented so I do not fork the engine.
- When I study the code, I want the shared simulation core to exist once (not four duplicated room copies) so the offline browser sim and the authoritative server cannot drift.
- When I deploy, I want `/healthz`, Prometheus-style `/metrics`, JSON logs, and a documented backup story.

### 2d. Player

An employee, event attendee, visitor, or community member playing in a browser on desktop or phone.

Jobs-to-be-done:
- When I get a link/QR code, I want to be in a match within seconds with no download, no account, and no plugin.
- When I play, I want the rules enforced fairly — no speed-hacks, no swinging during countdown, no ghost scoring — because prizes may be on the line.
- On mobile, I want touch controls that work; if I am colorblind or use a keyboard-only flow, I want the UI to remain usable.
- If the server drops mid-session, I want reconnection (or offline solo fallback in Waves) rather than a dead tab.

## 3. Product Pillars

1. **Server-authoritative integrity.** Colyseus owns every outcome: positions, HP, lifecycle, pickups, win conditions. Clients send validated intents only. Determinism of the shared sim core is a tested contract, enabling replay/audit evidence later.
2. **Zero-install browser delivery.** Three.js ES modules + importmap straight off static hosting; no build step, no app store, no native client. A QR code at a booth must be enough.
3. **Self-host simplicity.** One process serves client + game on :2567. One Docker container, `/healthz` for orchestration, Redis presence for multi-process when needed. "Runs on any VM with Docker in five minutes."
4. **White-label themability.** Theme tokens (logos, colors, names, sponsor slots) let a tenant make it theirs without forking; embed modes put it anywhere a web page lives.
5. **Observable / operable.** Structured JSON logs, Prometheus-style metrics with documented labels, health endpoint, graceful shutdown, audit trail for administrative actions.
6. **Extensible content pipeline.** CC0-first asset pipeline with manifest-driven fetches and credits tracking; config-driven classes/cards/skills/modes/biomes; licensing compliance is a feature, not paperwork.
7. **Fair monetization boundary.** The core stays permissively open (MIT); enterprise conveniences (hosted tier, support, compliance artifacts) define the paid surface without poisoning the OSS commons (the anti-pattern WorkAdventure's Commons Clause proves buyers reject).

## 4. Functional Requirements

IDs are stable and referenced by docs/ROADMAP.md. "(exists)" = shipped on master today and verified by the test suite (see docs/ARCHITECTURE.md section 7).

### Epic CORE — Core Gameplay

| ID | Requirement | Status |
|----|-------------|--------|
| FR-CORE-01 | PvE Waves survival: fixed-timestep server-authoritative simulation (TICK_MS=50), wave ramps, orbs, power-ups, intermission shop loop | exists |
| FR-CORE-02 | PvP Arena: duel/team/FFA rounds with lobby matchmaking and optional PvE toggle | exists |
| FR-CORE-03 | Chunked Open World: deterministic seeded worldgen (client renders chunks without syncing content), level-scaled spawns | exists |
| FR-CORE-04 | Four playable classes with distinct base stats and signature skills (Bash, Multishot, Firewave, Chain Lightning) | exists |
| FR-CORE-05 | Offline solo fallback for Waves mode (browser-local LocalRoom consuming the same shared sim core) | exists |
| FR-CORE-06 | Match lifecycle integrity: countdown attack-gate, ghost rules for the dead, respawn with spawn protection, play-again reset, join-during-gameover auto-restart | exists |

### Epic PROG — Progression

| ID | Requirement | Status |
|----|-------------|--------|
| FR-PROG-01 | XP curve with orb + kill XP, queued level-ups | exists |
| FR-PROG-02 | Upgrade-card roguelite picks: seeded 3-choice roll, 10s auto-pick deadline so PvP never stalls | exists |
| FR-PROG-03 | Intermission shop with heal/speed/vitality effects | exists |
| FR-PROG-04 | Per-class base stats and skills driven by shared config (`shared/skills.js`, `shared/classes.js`) | exists |
| FR-PROG-05 | Card pool extensible via data-only additions (UPGRADES entries + aggregateBonuses keys) without touching room logic | exists |

### Epic MP — Multiplayer & Matchmaking

| ID | Requirement | Status |
|----|-------------|--------|
| FR-MP-01 | Lobby queue grouped by mode/pve/rounds -> seat-reservation redirect into a fresh ArenaRoom | exists |
| FR-MP-02 | Reconnection grace window holding seat + state; client retries then falls back to fresh join | exists |
| FR-MP-03 | Room cap (default 12 players/room baseline); overflow gets a fresh room | exists |
| FR-MP-04 | Multi-process scale-out via Redis presence behind a load balancer — verified under load test, not just configurable | Q3 |
| FR-MP-05 | Custom game config API: per-tenant room presets (mode, rounds, waves difficulty, world seed, caps) supplied at create-time | Q3 |

### Epic ID — Identity & Accounts

| ID | Requirement | Status |
|----|-------------|--------|
| FR-ID-01 | Guest join by display name only (sanitized, color-assigned). No accounts required to play | exists (locked decision until SSO phase) |
| FR-ID-02 | Optional OIDC/OAuth2 login mapping verified identity -> player profile namespace; guest mode remains fully supported | Q2 |
| FR-ID-03 | Enterprise SSO story incl. SCIM-lite user lifecycle (provision/deactivate maps to profile enable/disable) | Q4 |

### Epic PERSIST — Persistence & Profiles

| ID | Requirement | Status |
|----|-------------|--------|
| FR-PERSIST-01 | Per-player JSON persistence (atomic tmp+rename, debounced 2s) for WorldRoom progression | exists — stays default storage until the adapter phase completes (DECIDED) |
| FR-PERSIST-02 | Storage adapter interface with Postgres driver behind it; JSON remains default driver; SQLite considered as middle option | Q2 |
| FR-PERSIST-03 | Player data export: machine-readable JSON download of everything stored about a player (GDPR Art. 15/20 posture) | Q2 |
| FR-PERSIST-04 | Player data deletion: hard-delete a player record via admin API (GDPR Art. 17 posture) | Q2 |
| FR-PERSIST-05 | Documented backup/restore procedure for the active storage driver | Q4 |

### Epic OPS — Platform Operations

| ID | Requirement | Status |
|----|-------------|--------|
| FR-OPS-01 | `GET /healthz` liveness/readiness with room/player gauges (Docker healthcheck target) | exists |
| FR-OPS-02 | Prometheus-style `GET /metrics` with documented label set (rooms, players, tick_ms, inputs/sec) | exists (labels doc: Q1) |
| FR-OPS-03 | Single-container Docker deploy serving client + game on :2567 | exists |
| FR-OPS-04 | Structured audit log (JSON-lines) for auth events, admin actions, exports/deletions | Q2 |
| FR-OPS-05 | On-prem Helm chart packaging the server (+ optional Redis presence) for K8s buyers | Q4 |
| FR-OPS-06 | SOC2-lite controls checklist (access, logging, change management, incident response) shipped as documentation | Q4 |
| FR-OPS-07 | Graceful degradation messaging when WebGL2 is unavailable on locked-down machines | exists (boot watchdog/login overlay error path) |
| FR-OPS-08 | Air-gap support: vendored third-party client assets (three importmap) so fully-offline enterprise networks run unmodified | Q2 |

### Epic WL — White-label & Embedding

| ID | Requirement | Status |
|----|-------------|--------|
| FR-WL-01 | Theme token system: colors, logos, class/card naming, lobby copy overridable per deployment/tenant | Q3 |
| FR-WL-02 | Embed mode: single `<script type="module">` or iframe snippet with room-code params and postMessage score reporting to the parent page | Q3 |
| FR-WL-03 | Branded lobby and sponsor slots (logo surfaces on login, countdown, results overlays) | Q3 |
| FR-WL-04 | Tenant-scoped branding resolution: theme selected by URL param/embed origin without cross-tenant leakage | Q3 |

### Epic CONTENT — Content Pipeline

| ID | Requirement | Status |
|----|-------------|--------|
| FR-CONTENT-01 | Manifest-driven asset pipeline (fetch-assets) with GLB validation, safe output paths, credits metadata under assets/credits/ | exists |
| FR-CONTENT-02 | Licensing compliance artifacts: top-level MIT LICENSE, NOTICE/third-party attribution report generated from credits data | Q1 |
| FR-CONTENT-03 | Template gallery v1: curated per-tenant game configs + theme packs published as starting points | Q4 |

### Epic FAIR — Anti-cheat & Fairness

| ID | Requirement | Status |
|----|-------------|--------|
| FR-FAIR-01 | Server authority over all outcomes; clients never send positions, only validated intents | exists |
| FR-FAIR-02 | Input validation (finite unit-ish direction), 30 msg/s input cap, per-IP join token bucket, name sanitization, static whitelist | exists |
| FR-FAIR-03 | Shared-sim parity tests pinning identical rules across GameRoom/ArenaRoom/WorldRoom/LocalRoom; duplication D2-D8 extracted so rules live once | exists (extraction: Q1) |
| FR-FAIR-04 | Replay determinism: ordered input recording per tick producing replay files + audit evidence for prize-backed competitions | stretch/Q5 backlog |

### Epic BIZ — Monetization-ready Hooks

| ID | Requirement | Status |
|----|-------------|--------|
| FR-BIZ-01 | License tiers defined: MIT core vs. enterprise agreement (support, compliance artifacts, hosted option) | Q4 |
| FR-BIZ-02 | Hosted vs self-host packaging distinction documented (what the hosted tier adds: multi-region, backups, SLA) | Q4 |
| FR-BIZ-03 | Billing/license enforcement hook (license key check stub in server boot; no phone-home in OSS build) | Q4 |

## 5. Non-functional Requirements

| Category | Requirement | Budget / Target |
|----------|-------------|-----------------|
| Performance (server) | Fixed-timestep tick processing stays within budget under max room occupancy | Tick 50ms cadence; p99 tick processing < 25ms with 12 players/room |
| Performance (join) | Time from JOIN click to in-match rendering | < 2s on broadband; model-load timeout guarded (15s ceiling with clear error) |
| Scale baseline | Concurrent players per room / per process | 12 players/room baseline (match.maxClients); >= 100 concurrent across rooms per modest VM; multi-process Redis presence load-tested in Q3 (scale target: 500 concurrent per deployment) |
| Availability | Self-host guidance for event-critical usage | Single-node restart < 30s; reconnect grace 15s covers blips; documented LB/replica pattern for higher availability |
| Security | Input validation, rate limiting, CORS, static whitelist | Server-side validation of every message; 30 msg/s input cap; per-IP join bucket (capacity 10, refill 0.5/s); CORS denied except PUBLIC_URL; /src/server lock-list; secrets never committed |
| Privacy / GDPR | Data minimization + subject rights | No personal data retained beyond display name + progression by default; FR-PERSIST-03 export and FR-PERSIST-04 deletion ship together (Q2); audit log records both |
| Accessibility | Input and perception coverage | Touch controls exist today (auto on touch devices); keyboard-only play fully supported (WASD/J/K/L/M); colorblind-safe palette review + non-color state cues tracked as backlog polish; reduced-motion respect for particles evaluated in Q3 theming work |
| Browser support | Matrix the client must pass Playwright smoke on | Chrome/Edge current-1, Firefox current-1, Safari current-1 (desktop); Safari iOS + Chrome Android current-1 for touch mode; WebGL2 required with graceful failure message (FR-OPS-07) |
| Operability | Observability defaults | JSON-line logs; /metrics gauges; SIGTERM graceful shutdown proven; structured audit log from Q2 |

## 6. Success Metrics

Adoption:
- GitHub stars >= 1,000 within 12 months of the 1.0 release.
- >= 25 verifiable self-host deployments (issue/report triangulation, deploy survey) by end of Q4.
- Docker Hub pulls trend month-over-month positive after image publication.

Engagement:
- Median session length >= 6 minutes for public demos (metrics-derived, aggregated).
- Week-2 player return rate >= 20% on persistent demo servers.
- >= 40% of sessions on public demo servers include >= 2 players (multiplayer stickiness).

Reliability:
- CI green rate >= 95% on master pushes after Q1 hardening.
- Crash-free sessions >= 99% (boot-watchdog + client error reporting in aggregate telemetry opt-in).
- Zero parity-test regressions: shared-sim tests stay green through refactors (D2-D8 extraction).

Business:
- >= 3 pilot deployments (startup embeds or corporate events) by end of Q4.
- >= 1 signed paid pilot/enterprise agreement conversation initiated from pilots.
- Procurement blockers closed: LICENSE merged (Q1), GDPR tooling shipped (Q2), scale-out evidence published (Q3) — each evidenced in docs/PROGRESS.md.

## 7. Out of Scope / Non-goals

- Native clients (mobile app stores, Steam builds). Browser is the platform.
- Metaverse ambitions: persistent social worlds, virtual land, avatars-economy. Arena sessions, not a universe.
- NFT/blockchain anything: assets, ownership, rewards. Never.
- Client-trusted netcode or P2P authority modes (anti-cheat pillar forbids it).
- MMORPG verticals (trading, guilds, mounts). nj-mmo occupies that niche; we stay session-based.
- First-party global hosting as the primary model in year one; hosted tier is a Q4 packaging decision built on pilot demand.
- Replacing Kahoot-style quiz flows; we complement them as the action-game slot in the agenda.

## 8. Open Questions

Each question lists the working default. Items already locked by the repo are marked DECIDED.

| # | Question | Working default |
|---|----------|-----------------|
| 1 | Which storage backend becomes default when adapters land? | DECIDED — JSON files remain the default until the Postgres adapter (FR-PERSIST-02) passes parity tests AND a migration guide ships; revisit no earlier than end of Q2. COMPETITORS.md recommends SQLite as middle default; decision deferred to adapter benchmarks. |
| 2 | Do accounts become mandatory? | DECIDED — no. Guest name-only join (FR-ID-01) is a locked EXPANSION_PLAN.md decision until the SSO phase; OIDC (FR-ID-02) is strictly optional on top. |
| 3 | MIT or Apache-2.0? | DECIDED — MIT (goal alignment + maximum simplicity). Apache-2.0's patent grant was weighed (COMPETITORS.md section 5) but rejected for brevity; NOTICE carries attributions (FR-CONTENT-02). |
| 4 | Knight Mixamo animation re-export timing | Deferred (locked decision): procedural knight animation stays until a source FBX is obtainable; not on the year-one roadmap. |
| 5 | Multi-process scaling target number | Default: verify 500 concurrent across N processes with Redis presence in the Q3 load test; publish the measured ceiling honestly instead of marketing numbers. |
| 6 | Trademark clearance for the name "Ashfall" | Default: treat as working title; run clearance search before any paid marketing push (COMPETITORS.md risk note). |
| 7 | Minors/COPPA exposure at school-adjacent events | Default: no birthdate collection ever; event organizers own attendance data; document data-flow so Ashfall stays out of scope for child-data processing. |
| 8 | Where does deterministic replay (FR-FAIR-04) land? | Default: stretch goal after 1.0; market the integrity story early (no competitor can cheaply copy it) but do not commit engineering before revenue signals. |

## FR-HUD-01: XP progress bar (cycle 26b)
Problem: level-ups arrive with no visible progression — XP appears only as a
raw number in hudText (GameScene.js "Lv N (M XP)"). In the survivors genre
the XP bar is the core continuous feedback loop; its absence makes upgrade
cadence feel random.
Solution:
- `xpProgress(level, xp)` pure evaluator in src/shared/progression.js next to
  xpForLevel -> {level, into, need, pct} where into = xp - xpForLevel(level),
  need = xpForLevel(level+1) - xpForLevel(level), pct clamped 0..1. Handles
  level<1 and xp beyond current threshold defensively.
- index.html: #xp-bar/#xp-fill styled after #hp-bar; GameScene sets fill
  width per HUD tick from synced PlayerState {level,xp} — client-only.
Out of scope: server changes, reward animations.
AC1 pct math pinned by node tests (exact values at known thresholds,
clamping, monotonic). AC2 full gate green.

## FR-HUD-02: low-HP danger vignette (cycle 26c)
Genre-standard persistent danger cue: while the local player is critically
hurt, an edge-only radial vignette pulses; the hit #flash alone gave no
standing "you are dying" signal.
- `lowHpFx(hp, maxHp)` pure in src/shared/sim/lowHpFx.js -> {on, intensity}:
  arms AT 30% hp (intensity 0), ramps linearly to 1 at 5%, clamped; dead or
  degenerate inputs return off — no divide-by-zero.
- index.html #danger edge-only radial (z 11, below hit flash); GameScene sets
  opacity per frame = intensity * sine pulse. Client-only.
AC pinned by test/lowHpFx.test.mjs (boundary at 30%, linear midpoint, clamp,
dead/degenerate). Full gate green.

## FR-HUD-03: wave-progress chip (cycle 26d)
Run-arc legibility: the finale victory arc (R6/R7) was invisible mid-run —
clients saw only "wave N" with no sense of distance to the Warlord.
- `waveChip(wave, finaleWave)` pure in shared/waves.js -> {label, pct,
  isFinale}; endless (finaleWave<=0) renders "WAVE N" with pct 0 and never
  flags finale; beyond-finale clamps pct at 1.
- #wave-chip under the xp bar (label + 3px track); red styling when
  isFinale. Reads SERVER.wave.finaleWave directly — same static config both
  rooms use, so online/offline agree by construction. No schema change.
AC pinned by test/waveChip.test.mjs. Full gate green.

## FR-UX-01: settings strip — volume + reduced FX (cycle 26e)
M-mute was the only audio control and screen shake/particles were
non-negotiable; accessibility and weak-device players had no lever.
- `resolveFxSettings`/`loadFxSettings`/`saveFxSettings` pure in
  shared/sim/fxSettings.js with injected storage (no localStorage in tests):
  absent volume -> default 1, present junk -> 0, corrupt stored blob ->
  defaults; reducedFx -> particleScale 0.35, shakeScale 0.
- GameScene applies once at boot and wraps particles.spawnBurst so ALL burst
  sites scale from one place; shake + trauma paths multiply by shakeScale.
- Bottom-right strip: range slider + REDUCED FX checkbox, persists on input,
  live-applies via sound.setVolume.
AC pinned by test/fxSettings.test.mjs (5 tests). Full gate green.

## FR-GAME-03: run kill counter (cycle 26f)
Players had no persistent "how many did I kill" feedback — score mixes orbs,
pickups and kills into one opaque number.
- PlayerState.kills (synced number, additive); LocalRoom uses the same class
  so offline parity is by construction.
- Shared combatBook credits at BOTH kill sites — resolveEnemyHit direct kills
  and tickBurns fatal sourced-burn ticks — via killer.kills = (kills ?? 0)+1;
  unattributed deaths credit nobody.
- Surfaced on hudText ("kills N") and the share card ({label:'Kills'} only
  when provided — old cards byte-identical).
AC pinned by test/killCounter.test.mjs. Full gate green.

## FR-RET-02: wave-clear orb vacuum (cycle 26g)
Leftover XP orbs rotted on the field at wave-clear — wasted value and a
"did I miss something" anxiety during the breather.
- During intermission, updatePickups in BOTH rooms treats every living
  player as a full-map magnet (pullOrbs radius Infinity) using the shipped
  magnet math; the existing proximity collection pays score/XP/charge as
  orbs arrive. Playing-state behavior unchanged (control-pinned).
- Identical wiring byte-for-byte in GameRoom + LocalRoom (parity by
  construction); no schema/payload changes.
AC pinned by waves.test vacuum block (playing control + convergence budget)
and a magnetPull Infinity-radius unit pin. Full gate green.

## FR-RET-03: replay counter reset + time survived (cycle 26h)
Two gaps closed together:
- BUG (FR-GAME-03 follow-up): PlayerState.kills was not in resetMatchState's
  player loop — kill counts carried across replays. Now reset with score.
  Pinned by test/runSummary.test.mjs.
- Time survived: pure formatRunTime(sec) M:SS renderer in shareCard.js
  (clamps junk/negative to 0:00); GameScene stamps a client-side run clock on
  the wave-1 playing transition and surfaces "SURVIVED M:SS" + a Time stat
  line on the gameover card/share card when known.
- STABILITY: daily.test clearWave was the only clear helper draining level-up
  cards AFTER intermission — a pause-wall freeze mid-clear or stray contact
  death could end the run pre-victory (3/5 fail rate reproduced on clean
  HEAD). Fixed to swing-until-clear polling with mid-clear card drains +
  death-proofed player hp; 8/8 consecutive green.
AC pinned by test/runSummary.test.mjs. Full gate green.
