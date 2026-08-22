# Ashfall — One-Year Roadmap

Status: v1 (2026-08-22). Derived from docs/PRD.md epics (FR ids are stable there) and the gap analysis in docs/COMPETITORS.md. Tracking lives in docs/PROGRESS.md.

Plan shape: 4 quarters, each with an explicit theme. Phases inside a quarter respect dependencies; estimates are agent-weeks (one agent working full-time on the repo). The repo's existing engineering debts are scheduled as first-class phases, not background noise.

---

## Quarter 1 — Harden & License

**Goal:** Remove the procurement-killing blockers and make every future change safe to make: a license that lets enterprises legally touch the code, a CI floor that is green on every push, and a simulation core where each rule lives exactly once.

### Phase 1.1 — MIT LICENSE + attribution NOTICE
- FR refs: FR-CONTENT-02, groundwork for FR-BIZ-01.
- Deliverables: top-level `LICENSE` (MIT), `NOTICE` with third-party attributions generated from `assets/credits/` metadata, README license badge/section.
- Acceptance criteria: `LICENSE` exists at repo root containing the MIT text; `NOTICE` lists every non-CC0 asset (Knight CC-BY 3.0, Mage CC-BY 3.0) with author + source URL; `npm run check && npm test` still green; no other file semantics changed.
- Dependencies: none.
- Estimate: 0.5 agent-weeks.

### Phase 1.2 — CI gate on every push
- FR refs: FR-OPS-02 (observability of build health), FR-FAIR-03 (parity tests enforced).
- Deliverables: syntax + test gate running automatically on push/PR.
- Status: **DONE** — the local CI gate already exists and is the merge habit (`npm run check && npm test`, 17 test files / 39 tests verified green on master per docs/ARCHITECTURE.md section 7); wiring it into hosted CI lands alongside Phase 1.5.
- Dependencies: none.
- Estimate: 0 (residual wiring tracked in 1.5).

### Phase 1.3 — Extract shared-sim duplication D2-D8
- FR refs: FR-FAIR-03, supports FR-CORE-05 (offline parity stays tested).
- Deliverables: per docs/ARCHITECTURE.md sections 5.1-5.2, extract the SAFE-TO-EXTRACT mirrored blocks into shared modules consumed by GameRoom AND LocalRoom (and reused by ArenaRoom/WorldRoom where identical): D2 progression bookkeeping, D3 intermission shop effects, D4 burn DoT (inject clock fn), D5 enemy-hit resolution (log callback), D6 room-level projectile loop, D7 pause wall/auto-pick deadline logic, D8 match reset. RISKY items D9-D13 are explicitly NOT in scope until drift reconciliation is decided separately.
- Acceptance criteria: all parity tests (`combat.test.mjs` part 2, `waves.test.mjs`, `phase4.test.mjs`, `projectiles.test.mjs`) pass unchanged or with only strengthened assertions; each extracted module unit-tested first (red -> green); GameRoom.js and LocalRoom.js shrink by the duplicated line counts; behavior byte-equivalent (same seeded rolls, same knockback numbers).
- Dependencies: none (pure refactor behind existing tests).
- Estimate: 4 agent-weeks.

### Phase 1.4 — Flaky-test elimination
- FR refs: FR-FAIR-03.
- Deliverables: identify and fix timing-dependent assertions (the class of bug fixed by commit de77d54 "fix: flaky phase4 assertion"); historical probe scripts (`fixproof.py`, `shotproof.py`, `burstprobe.py`, `test/shots/*.png`) were removed in the redundant-tooling cleanup; focus on timing-dependent assertions like the class fixed by de77d54.
- Acceptance criteria: `npm test` x20 consecutive runs locally with zero failures; CI run on 3 consecutive pushes green; deleted files listed in PROGRESS.md evidence.
- Dependencies: Phase 1.2 (gate to observe flakiness against).
- Estimate: 1 agent-week.

### Phase 1.5 — Playwright e2e in hosted CI
- FR refs: FR-OPS-02, browser-support NFR (section 5 matrix).
- Deliverables: promote the manual `python3 test/browser.test.py` into the hosted pipeline (boot server in CI job, install chromium, run headless e2e, publish artifacts on failure); document metric labels for `/metrics` while touching ops surface.
- Acceptance criteria: a deliberately broken client-wiring change fails CI (verified once by revert experiment); e2e runtime < 10 minutes; README updated so local dev flow unchanged.
- Dependencies: Phase 1.4 (stable suite before gating on it).
- Estimate: 2 agent-weeks.

**Q1 total estimate: ~7.5 agent-weeks.**

---

## Quarter 2 — Platform Foundations

**Goal:** Make Ashfall pass an enterprise security/privacy review: optional real identity, storage with admin tooling and data-subject rights, audit trail, and offline-capable assets.

### Phase 2.1 — OIDC/OAuth2 login option
- FR refs: FR-ID-02, FR-ID-01 preserved.
- Deliverables: server-side OIDC authorization-code flow (discovery URL + client id/secret via env), identity -> profile namespace mapping, login screen "sign in" affordance beside guest join; guests remain the default path with zero friction.
- Acceptance criteria: integration test boots a stub OIDC provider and proves token -> session mapping; guest join path untouched (existing tests pass unmodified); unauthenticated WebSocket joins still work; rate limits apply identically to both paths.
- Dependencies: Phase 1.x complete (safe base).
- Estimate: 3 agent-weeks.

### Phase 2.2 — Persistence adapter interface + Postgres driver
- FR refs: FR-PERSIST-02, FR-PERSIST-01 default preserved.
- Deliverables: `PlayerStore` interface (load/save/delete/export) implemented by JsonFileStore (current behavior) and PostgresStore; selection via env; JSON import/export tooling between drivers; JSON remains default until parity + migration guide ship.
- Acceptance criteria: WorldRoom persistence round-trip test passes against both drivers; concurrent-save stress test (100 parallel saves) passes on Postgres and documents JSON-file limitations honestly in README; switching drivers requires zero room-code changes; default deployment unchanged when env unset.
- Dependencies: Phase 1.3 (rooms consume shared bookkeeping, smaller diff surface).
- Estimate: 3 agent-weeks.

### Phase 2.3 — Admin API + GDPR subject rights + audit log
- FR refs: FR-PERSIST-03, FR-PERSIST-04, FR-OPS-04.
- Deliverables: authenticated admin endpoints (admin token env): export player record as JSON, hard-delete player record, list players; JSON-lines structured audit log recording auth events, exports, deletions, admin actions; documentation of the data inventory (what Ashfall stores: name, color, progression, nothing else).
- Acceptance criteria: export returns byte-complete record matching what load returns; deletion removes the record and is reflected in audit log with actor+timestamp; admin endpoints rejected without valid token (test); audit log survives server restart; privacy NFR table in PRD marked satisfied.
- Dependencies: Phase 2.2 (deletion/export must work across drivers via the interface).
- Estimate: 3 agent-weeks.

### Phase 2.4 — Air-gapped asset vendoring
- FR refs: FR-OPS-08.
- Deliverables: vendor three.js/importmap assets into the repo (or a release tarball) selectable via env; CDN remains default; documented fully-offline deploy recipe.
- Acceptance criteria: fresh container with outbound network blocked serves a playable Waves session using vendored assets; default path still uses CDN (no size regression complaints); smoke script covers vendored mode.
- Dependencies: none within the quarter.
- Estimate: 1 agent-week.

**Q2 total estimate: ~10 agent-weeks.**

---

## Quarter 3 — White-label & Embed

**Goal:** Ship the sharpest commercial wedge from COMPETITORS.md: paste-one-snippet embeddable branded play plus tenant-configurable rooms, and prove scale-out under load instead of claiming it.

### Phase 3.1 — Theme token system
- FR refs: FR-WL-01, FR-WL-04.
- Deliverables: theme token file (colors, logos, class/card label overrides, lobby copy) loaded per deployment; tenant resolution by URL param/embed origin; tokens drive login screen, HUD accents, countdown/results overlays.
- Acceptance criteria: sample theme renders all named surfaces without code changes; unknown tenant falls back to default theme; two tenants in one process show different branding simultaneously (test via headless client boot); no cross-tenant token leakage (negative test).
- Dependencies: Phase 1.5 (browser e2e to verify visual surfaces).
- Estimate: 2 agent-weeks.

### Phase 3.2 — Embed mode (iframe / script tag + postMessage)
- FR refs: FR-WL-02.
- Deliverables: minimal embed entry (`?embed=1`) stripping chrome, sizing to parent iframe; documented `<script type="module">` and `<iframe>` snippets; postMessage protocol for score/gameover reporting to parent origin (origin-checked).
- Acceptance criteria: Playwright e2e hosts a parent page, embeds a match, receives a well-formed score message on gameover; messages to non-whitelisted origins dropped (security test); embed mode coexists with normal play on same server.
- Dependencies: Phase 3.1 (branded embed needs tokens).
- Estimate: 3 agent-weeks.

### Phase 3.3 — Branded lobby & sponsor slots
- FR refs: FR-WL-03.
- Deliverables: sponsor/logo slots on login, countdown, and results overlays driven by theme tokens; graceful absence when unset.
- Acceptance criteria: overlays render with zero configured sponsors (no broken images); with sponsor set, asset appears on all three surfaces in e2e screenshots; slot count capped to protect performance budget.
- Dependencies: Phase 3.1.
- Estimate: 2 agent-weeks.

### Phase 3.4 — Custom game config API (per-tenant rooms)
- FR refs: FR-MP-05.
- Deliverables: create-time room options API (mode, roundsToWin, wave difficulty, world seed, caps, PvE toggle) exposed to embed/admin callers with server-side validation clamps.
- Acceptance criteria: invalid configs rejected at create-time (bounds tests); two rooms with different configs run concurrently without interference; existing defaults byte-identical when options omitted.
- Dependencies: none beyond Q1 base; benefits from Phase 3.2 consumers.
- Estimate: 2 agent-weeks.

### Phase 3.5 — Scale-out pilot: Redis presence under load
- FR refs: FR-MP-04.
- Deliverables: load-test harness (headless Colyseus clients) driving N processes behind a load balancer with REDIS_URL presence; measured report published (concurrent players, p99 tick, join latency); fix whatever it exposes.
- Acceptance criteria: >= 500 concurrent players across >= 4 processes with matchmaking working across processes (cross-process lobby redirect proven in test); p99 tick processing < 25ms sustained; report committed to docs/ with reproduction commands.
- Dependencies: Phase 2.2 (Postgres recommended for multi-process persistence story).
- Estimate: 2 agent-weeks.

**Q3 total estimate: ~11 agent-weeks.**

---

## Quarter 4 — Enterprise GA

**Goal:** Turn pilots into procurement-ready product: enterprise identity lifecycle, licensing tiers, K8s packaging, compliance checklist, template gallery, and the 1.0 release.

### Phase 4.1 — SSO story + SCIM-lite lifecycle
- FR refs: FR-ID-03, extends FR-ID-02.
- Deliverables: enterprise SSO guidance built on the Q2 OIDC layer (Azure AD/Okta recipes); SCIM-lite subset: provision/deactivate user -> profile enabled/disabled flag enforced at join/auth.
- Acceptance criteria: deactivated identity cannot join or resume (test); provisioning creates disabled-until-first-login profiles; guest path unaffected; docs include one worked Okta example.
- Dependencies: Phase 2.1, Phase 2.3.
- Estimate: 3 agent-weeks.

### Phase 4.2 — License tiers + billing/license hooks
- FR refs: FR-BIZ-01, FR-BIZ-02, FR-BIZ-03.
- Deliverables: pricing/packaging page defining MIT core vs enterprise agreement; hosted-vs-self-host feature matrix; license-key check hook at boot (no phone-home in OSS build; enterprise image validates key).
- Acceptance criteria: OSS build runs with zero license checks (test asserts absence); enterprise build refuses invalid key with actionable error; feature matrix reviewed against shipped reality (no vaporware rows).
- Dependencies: Phase 3.x (white-label features define the enterprise tier contents).
- Estimate: 2 agent-weeks.

### Phase 4.3 — On-prem Helm chart
- FR refs: FR-OPS-05, FR-PERSIST-05 (backup procedure documented for chart volumes).
- Deliverables: Helm chart packaging server (+ optional Redis), values for replicas/PUBLIC_URL/resources, healthcheck wired, backup/restore runbook for the active storage driver.
- Acceptance criteria: chart deploys on a clean kind cluster and passes `/healthz` readiness; two-replica deployment passes the Q3 cross-process matchmaking check; restore runbook executed once end-to-end with evidence.
- Dependencies: Phase 3.5 (multi-process verification), Phase 2.2 (Postgres option).
- Estimate: 2 agent-weeks.

### Phase 4.4 — SOC2-lite controls checklist
- FR refs: FR-OPS-06, FR-OPS-04 evidence trail.
- Deliverables: controls documentation mapped to common enterprise questionnaire sections: access control (admin token, OIDC), logging/monitoring (JSON logs, metrics, audit log), change management (CI gates, tagged releases), incident response (runbook), vendor management (dependency inventory from NOTICE).
- Acceptance criteria: checklist answers >= 80% of a standard security questionnaire without "not applicable"; each control links to its enforcing artifact (file, endpoint, or CI job).
- Dependencies: Phase 2.3 (audit log is the evidence backbone).
- Estimate: 1 agent-week.

### Phase 4.5 — Template/marketplace gallery v1
- FR refs: FR-CONTENT-03, leverages FR-WL-01, FR-MP-05.
- Deliverables: curated gallery of tenant starter packs (theme + room config + credits-clean asset notes) published in-repo; loader applies a pack id at deploy time.
- Acceptance criteria: each template deploys and plays via one config change; templates carry complete license metadata passing the NOTICE generator; gallery index lists >= 5 templates.
- Dependencies: Phase 3.1, Phase 3.4.
- Estimate: 3 agent-weeks.

### Phase 4.6 — 1.0 release
- FR refs: closes FR-BIZ-01/02 externally; stretch FR-FAIR-04 if capacity remains.
- Deliverables: version tag 1.0.0, release notes mapping shipped FR ids to evidence, migration guide (JSON -> Postgres optional), marketing one-pager for pilots.
- Acceptance criteria: full suite green on release commit; Docker image tagged 1.0.0 and smoke-tested; every PRD FR row marked exists/shipped or explicitly deferred in release notes.
- Dependencies: Phases 4.1-4.5.
- Estimate: 1 agent-week (+stretch budget for FR-FAIR-04 replay MVP: ordered-input recorder producing a re-simulatable log, accepted only with determinism proof across two independent runs).

**Q4 total estimate: ~12 agent-weeks.**

---

## Sequencing Rationale (tied to COMPETITORS.md)

| Quarter | Competitor weakness exploited | Why this order |
|---------|-------------------------------|----------------|
| Q1 Harden & License | WorkAdventure's resale-blocking AGPL + Commons Clause is called out in COMPETITORS.md as the closest OSS engagement platform buyers cannot legally buy; Ashfall's own missing LICENSE is listed as the #1 blocker ("procurement will bounce it instantly"). lance.gg/Open Match dormancy shows abandoned/unmaintained signals disqualify projects — hence flaky-test cleanup and hosted CI as maintenance-hygiene signals. | Legal permission precedes everything; D2-D8 extraction de-risks all later feature work because four-copy rule maintenance is the largest defect risk in the codebase (ARCHITECTURE.md section 5.2). |
| Q2 Platform Foundations | ClassQuiz (~700 stars) already ships OpenID login — COMPETITORS.md notes even quiz-tier OSS meets the identity bar Ashfall must clear; Nakama/Agones prove enterprises fund authority-plus-ops infrastructure. Gather.town's closed cloud blocks the data-residency answer enterprises need. | Identity, storage adapter, GDPR rights, and audit logs are exactly the security-review gates named in the persona JTBD; they unlock pilots regardless of white-label polish, so they precede cosmetics. |
| Q3 White-label & Embed | COMPETITORS.md positions the zero-build embeddable widget as RECOMMENDED #1 ("No competitor OSS game offers drop-in embedding") and single-container self-host as RECOMMENDED #2 vs Agones' Kubernetes prerequisite. Trystero cannot copy the integrity story (P2P has no authority), but scale-out must be proven, not asserted, to beat Agones' fleet narrative. | Embedding depends on theming (tokens first), and tenant rooms give embeds something configurable; the load-test converts the known single-process ceiling (COMPETITORS.md risk #2) from a liability into published evidence. |
| Q4 Enterprise GA | Kahoot/Gather.town prove budget exists but price per-seat and forbid self-hosting; the counter-offer (SSO/SCIM, Helm, compliance checklist, flat-cost self-host, clean license tiers) is precisely the procurement package their stacks lack. Marketplace v1 mirrors the template economics Razzia/ClassQuiz lack entirely. | GA items are packaging of Q2/Q3 capabilities; billing tiers need the white-label feature list to describe; 1.0 ships only after the pilot-critical gates (license, GDPR, scale evidence) have been closed for at least a quarter. |

Deferred by design: FR-FAIR-04 deterministic replay stays a stretch item — COMPETITORS.md ranks it NICE-TO-HAVE behind the embed/self-host/OIDC bets due to high engineering cost, but it is marketed early because no surveyed competitor can copy server-authoritative replay cheaply.
