# Ashfall — Competitive Landscape & Positioning

Last updated: 2026-08-22. Star counts and maintenance status are approximate (they drift weekly); licenses verified via GitHub/web search in August 2026.

Ashfall is an open-source, server-authoritative multiplayer 3D arena-survivor browser game: Three.js client with a zero-build ES-module + importmap setup, Colyseus 0.17 Node.js server serving both client and game on one port (:2567), PvE waves, PvP arena with lobby matchmaking, chunked open-world mode, roguelite upgrade cards, four classes, procedural WebAudio, CC0 asset pipeline with credits tracking, per-player JSON persistence, Prometheus-style `/metrics`, `/healthz`, Docker deploy, GitHub Pages + Cloudflare Tunnel play-with-friends flow, and an offline solo fallback sim in the browser.

This document maps the competitive landscape and positions Ashfall for enterprise and startup buyers evaluating it as a customizable engagement platform: corporate events, marketing mini-games, team building, white-label deployments.

## 1. Executive summary

- The market splits into infrastructure nobody can play (Colyseus, Nakama, Agones: frameworks/servers with no shipped game) and games nobody can buy (OSS demos like agar.io-clone, single-player survivors templates). Almost nobody occupies "shipped, licensable, server-authoritative multiplayer game that runs in a browser tab" — that intersection is Ashfall's white space.
- B2B engagement buyers already pay handsomely for interactivity (Kahoot, Gather.town, WorkAdventure-style events), but incumbents are quizzes and 2D walk-around spaces; none offer real-time 3D skill-based team play, and the closest OSS option carries resale-blocking license terms (WorkAdventure: AGPL-3.0 + Commons Clause).
- Server authority plus deterministic replay is an integrity/anti-cheat story no P2P or client-trusted competitor (Trystero, most survivors clones) can copy cheaply — a strong differentiator when enterprises run branded competitions with real prizes.
- Enterprise readiness gates are operational more than technical: the missing top-level LICENSE file, the single-process scaling ceiling, and file-based persistence are the three concrete blockers between Ashfall and procurement approval; all are weeks-not-months fixes.
- Zero-build delivery (ES modules + importmap straight off static hosting) enables a "paste one iframe or script tag" embed story that heavyweight stacks (Unity/Mirror clients, native Luanti/Veloren builds, K8s-only Agones fleets) structurally cannot match — ideal for marketing sites, intranet portals, and event big-screens.

## 2. Comparison table

| Project | License | Stack | Multiplayer model | B2B readiness | Key gap Ashfall can exploit |
|---|---|---|---|---|---|
| Ashfall (this repo) | none yet — add MIT or Apache-2.0 | TypeScript, Three.js, Colyseus 0.17, Node :2567 | Server-authoritative rooms: PvE waves + PvP lobby matchmaking + chunked open world | Emerging: Docker, /metrics, /healthz, offline fallback | n/a |
| Colyseus | MIT | TypeScript / Node.js | Authoritative room SDK: state sync, matchmaking, rooms | Low-medium (framework only, no game product) | Ashfall is the ready-made game on this exact stack |
| Nakama | Apache-2.0 | Go server + Lua/TS/JS runtime modules | Authoritative backend services: matchmaker, storage, social, leaderboards | Medium-high as infra; ships no gameplay content | Bundles actual playable game + ops on top of equivalent authority guarantees |
| Agones | Apache-2.0 | Go + Kubernetes CRDs | Fleet orchestration of dedicated game servers (allocates GameServers) | High for infra teams, K8s-only prerequisite | Single-container self-host vs. cluster-sized commitment |
| Open Match | Apache-2.0 | Go microservices (K8s) | Matchmaking framework only (no servers, no game) | Low — dormant since Dec 2023 after maintainers stepped down | Lobby matchmaking already built-in; no dead dependency risk |
| Socket.IO | MIT | Node.js / browser | Transport layer (rooms, broadcast); authority is DIY | Low (plumbing only) | Everything above transport: state model, game rules, modes |
| Geckos.io | BSD-3-Clause | Node.js + WebRTC DataChannel | UDP-like unreliable transport for real-time games | Low; sparse maintenance | Actively maintained authoritative stack with reconnection and metrics |
| lance.gg | Apache-2.0 | JavaScript (browser + Node) | Entity interpolation / netcode engine | Very low; effectively dormant since 2018-2019 | Maintained alternative; no abandoned-netcode risk story needed |
| Trystero | MIT | JavaScript, serverless P2P (WebTorrent/Nostr/MQTT/IPFS/Firebase/Supabase) | Decentralized P2P rooms, no central authority | Low: no anti-cheat, no observability, no identity hooks | Server authority = cheat-resistant branded competitions |
| Mirror | MIT | Unity C# | Host/client + relay for Unity games | Medium for Unity shops; no browser target | Browser-native zero-install delivery |
| agar.io-clone | MIT | Node.js + socket.io demo code | Single-process semi-authoritative blob arena | Low: tutorial-grade code; revived 2025 under new ownership | Production polish: modes, progression, persistence, metrics, deploy |
| nj-mmo | MIT | TypeScript, Colyseus 0.17 + Three.js, Nx monorepo, SQLite + Drizzle | Authoritative rooms: browser MMORPG vertical slice (L2-inspired) | None yet: ~15-star project created July 2026 | Same-stack cousin; Ashfall wins on genre polish, ops features, B2B surface |
| Luanti (ex-Minetest) | LGPL-2.1+ (engine) | C++ engine, Lua modding, native client | Client-server voxel sandbox worlds | Medium: self-host communities exist; heavy client install | Browser access, curated corporate events, no client download |
| Veloren | GPL-3.0 | Rust, native client (wgpu) | Client-server multiplayer RPG | Low for B2B: copyleft + native client + community governance | Permissive license path, browser delivery, white-label control |
| Godot Survivors Starter Kit | MIT | Godot 4 (C#) | Local/offline single-player template | None (dev template, not a product) | Networked co-op/arena survivor playable in a browser tab |
| WorkAdventure | AGPL-3.0 + Commons Clause | TypeScript, Phaser, Node | Room-based 2D virtual offices/events | High demand, but Commons Clause forbids selling a hosted offering | True 3D action gameplay under clean commercial-friendly OSS terms |
| Gather.town | Proprietary SaaS | Closed | Hosted virtual spaces, 2D sprites | Proven enterprise market, per-user pricing | Self-hostable source-available alternative with custom game modes and price headroom |
| Kahoot! | Proprietary SaaS | Closed | Quiz engagement at scale | Market leader; enterprise tiers are expensive | Skill-based 3D play instead of multiple-choice quizzes; white-label at sane prices |
| ClassQuiz | MPL-2.0 | Python (FastAPI) + SvelteKit, socket.io | Self-hosted Kahoot-style quizzes; hosted at classquiz.de | Small OSS project (~700 stars) with OIDC login | Same quiz-vs-game gap as Kahoot, plus actual gameplay depth |
| Razzia | MIT | React + TypeScript, Docker Compose | Self-hosted Kahoot-style quiz for smaller events (ex-Rahoot) | Growing (~1k stars), event-focused | Same gap: quiz-shaped, no real-time 3D action play |

### 2.1 How to read the landscape

Four concentric rings surround Ashfall, each failing a different enterprise requirement:

1. **Frameworks (Colyseus, Nakama, Agones, Open Match, Socket.IO, Geckos.io, lance.gg):** healthy licenses, real maintenance — but zero shipped gameplay. A buyer must fund a dev team before anything is playable.
2. **Games/templates (agar.io-clone, nj-mmo, Luanti content, Veloren, survivors kits):** playable — but demo-grade ops, heavy clients, or copyleft terms block procurement and embedding.
3. **Engagement platforms OSS (WorkAdventure, ClassQuiz, Razzia):** B2B-ready distribution and event workflows — but quiz/2D-walk shapes, or resale-restricted licenses.
4. **Proprietary leaders (Kahoot, Gather.town):** prove budget exists — but closed, per-seat priced, no self-host, no source access.

Ashfall's thesis: sit in the empty center of all four rings — shipped game, clean license, browser delivery, server authority, ops hooks.

## 3. Deep dives

### 3a. OSS multiplayer frameworks and servers

**Colyseus** — https://github.com/colyseus/colyseus — MIT, ~7.2k stars, actively maintained (monorepo with SDKs for Unity, Defold, Construct, Haxe, JS) plus paid Cloud/Arena add-ons. Rooms, binary state synchronization, matchmaking, and monitoring tooling out of the box; it is the backbone Ashfall already runs on. It is a framework: buyers get plumbing and must build their own game, which most event/marketing teams cannot do. Gap exploited: Ashfall converts framework plumbing into a shippable, brandable product while staying on the same trusted MIT foundation.

**Nakama** — https://github.com/heroiclabs/nakama — Apache-2.0, ~12.9k stars, maintained by Heroic Labs with a commercial ecosystem. Production-grade authoritative backend: users, auth, storage, matchmaker, leaderboards, groups, server runtime in Lua/TS/Go. It solves backend services, not gameplay; there is no game to embed in a marketing page. Gap exploited: Ashfall offers comparable authority guarantees plus finished game content, and its roadmap can adopt Nakama as an optional backend rather than competing with it.

**Agones** — https://github.com/agones-dev/agones (moved from googleforgames/agones) — Apache-2.0, ~6.9k stars, Google-originated and active (v1.59 released July 2026). Kubernetes CRDs that allocate, scale, and health-check dedicated game-server processes ("fleets"); used in production by Ubisoft, Embark, and others. Excellent infra, but it presupposes a Kubernetes cluster and a separately-built game server; procurement-heavy orgs love it, everyone else bounces off. Gap exploited: one Docker container running client + game on :2567 versus a cluster-sized platform commitment, with a future Agones adapter as an upsell path.

**Open Match** — https://github.com/googleforgames/open-match — Apache-2.0, ~3.4k stars, dormant since December 2023 (final release v1.8.1 shipped 2023-12-13; maintainers stepped back). A matchmaking-only microservice framework aimed at large studios. Building on it today means inheriting an unmaintained dependency. Gap exploited: Ashfall's lobby matchmaking is built-in and maintained, removing a whole integration and support surface.

**Socket.IO** — https://github.com/socketio/socket.io — MIT, ~62k stars, extremely active. Reliable WebSocket transport with rooms, namespaces, auto-reconnect; it deliberately does not define game state or authority. Thousands of tutorials mean every team starts here, then stalls building sync, prediction, and reconnection themselves. Gap exploited: everything above the transport layer — game state model, rules, modes, balancing, metrics — which is exactly what buyers want to configure rather than write.

**Geckos.io** — https://github.com/geckosio/geckos.io — BSD-3-Clause, ~1.5k stars, sparse maintenance (npm updates as recent as March 2026 signal light upkeep by a single maintainer). WebRTC DataChannel wrapper giving Node games UDP-like unreliable channels. Interesting transport layer, thin ecosystem, unclear long-term stewardship. Gap exploited: an authoritative, maintained full stack with reconnect handling and observability instead of a raw channel library.

**lance.gg** — https://github.com/lance-gg/lance — Apache-2.0, ~1.7k stars, effectively dormant since 2018-2019 (release history stops years back). Ambitious JS netcode engine (client-side prediction, interpolation) used by some demos; partially succeeded by the Incheon experiment. An abandoned core dependency is disqualifying for enterprise procurement. Gap exploited: being alive — maintained repo, responsive owner, no archaeology required.

**Trystero** — https://github.com/dmotz/trystero — MIT, ~2.6k stars, maintained. Serverless P2P rooms over Nostr (default), BitTorrent, MQTT, IPFS, Firebase, Supabase, or a self-hosted WebSocket relay; brilliant for demos and small cooperative apps. No central authority means no anti-cheat, no audit trail, no SLA-grade observability — non-starters for prize-backed branded events. Gap exploited: server authority as an integrity feature (deterministic replay, input audit), impossible by design in P2P.

**Mirror** — https://github.com/MirrorNetworking/Mirror — MIT, ~6.2k stars, actively maintained by a company (Germany-based). The dominant open networking library for Unity: host/client plus relay, transports, interest management; claims 200M+ player reach. Locked to Unity builds: players download a client, hosts run executables, embedding is impossible. Gap exploited: browser-native zero-install sessions opened from a QR code at an event booth.

### 3b. OSS browser games and templates

**agar.io-clone** — https://github.com/owenashurst/agar.io-clone (originally by huytd) — MIT, ~3k stars; ownership transferred and the project was revived in 2025, but it remains socket.io-era demo code. Proof that browsers can host mass-multiplayer arenas; also proof of how far demo code is from production: no persistence, no metrics, no deploy story, minimal authority. Gap exploited: production polish — progression, classes, modes, persistence, metrics, health checks, Docker, offline fallback.

**nj-mmo** — https://github.com/tech-leads-club/nj-mmo — MIT, ~15 stars, created July 2026, actively developed. A fully playable low-poly 3D browser MMORPG vertical slice inspired by Lineage 2 Classic's Talking Island: authoritative Colyseus 0.17 server + Three.js client, Nx monorepo with shared deterministic game-core rules, SQLite + Drizzle persistence, everything on :2567. Architecturally this is Ashfall's closest cousin — same stack, same authority philosophy — but it is a tiny community project with an MMORPG genre focus and none of the B2B surface (no metrics endpoint story, no SSO, no embeddability, no event tooling). Gap exploited: genre fit for short competitive sessions, operational maturity (health/metrics/Docker), licensing-plus-governance hygiene, and B2B features a hobby monorepo will not prioritize.

**Luanti (formerly Minetest)** — https://github.com/luanti-org/luanti — LGPL-2.1+ engine (mixed licensing across subprojects), ~13k stars, very active community; renamed from Minetest in October 2024. Battle-tested client-server voxel sandbox platform with Lua modding; requires a native client install. Strong in education/community hosting, weak where a browser tab and corporate branding are required. Gap exploited: instant browser access, curated short-session events, white-label theming without forking an engine.

**Veloren** — primary at https://gitlab.com/veloren/veloren (GitHub mirror ~7.5k stars) — GPL-3.0-or-later, active volunteer project. Impressive Rust multiplayer action RPG with original CC assets; native client, copyleft license, community governance. Not embeddable, not brandable, and GPL complicates closed internal customizations. Gap exploited: permissive-license path plus browser delivery for commercial customization scenarios Veloren cannot serve.

### 3c. Survivors-like OSS

**Godot Survivors Starter Kit** — https://github.com/DarkRewar/SurvivorsStarterKit — MIT, ~100 stars, created October 2023, Godot 4 (C#). Implements the vampire-survivors loop (auto-attack, progression curve, upgrades for player and enemies, boss spawns) as a local single-player template. Popular as a learning resource; like every survivors-like template surveyed (itch.io packs such as Martin Senges' paid Godot 4 template), it ships no networking and does not run in a browser as a service. Gap exploited: Ashfall is the networked, server-authoritative, browser-delivered survivor — co-op and PvP where templates stop at local play.

### 3d. B2B engagement platforms

**WorkAdventure** — https://github.com/workadventure/workadventure — AGPL-3.0 restricted by Commons Clause, ~5.5k stars, backed by an active French company. 2D map-based virtual offices and events with video integration. Widely used for team events, but the vendor's own FAQ states you may not "sell a version of WorkAdventure online as a service" — they are the sole entity allowed to sell hosted subscriptions — and AGPL obligations apply to modifications. Gap exploited: clean commercial-friendly OSS terms (MIT/Apache-2.0) plus genuine 3D skill-based team gameplay rather than walking avatars between video calls.

**Gather.town** — proprietary hosted SaaS for virtual offices and social spaces; proven enterprise willingness-to-pay with per-user subscriptions. Closed source: no self-hosting, limited theming, pricing scales linearly with headcount. Gap exploited: self-hosted deployment inside the customer's perimeter, source-available customization, and flat-cost economics for large events.

**Kahoot!** — proprietary engagement giant; quizzes at massive scale, expensive enterprise tier, strong brand. Its interactivity ceiling is multiple-choice; no real-time action play. Gap exploited: offer skill-based 3D competition as the "next Kahoot" for team-building budgets, with white-label options priced sanely.

**ClassQuiz** — https://github.com/mawoka-myblock/ClassQuiz — MPL-2.0, ~700 stars, created 2022; Python/FastAPI backend with SvelteKit frontend and socket.io play. Self-hostable open-source Kahoot alternative with a hosted instance at classquiz.de, and notably GitHub/Google/OpenID login already built in — proof that even quiz-tier OSS meets enterprise identity expectations Ashfall must match. Still squarely quiz territory with a multi-container stack (Postgres, Redis, Meilisearch, Caddy). Gap exploited: same as Kahoot's gap, delivered self-hosted and permissive — plus actual game mechanics in a single container.

**Razzia** — https://github.com/Ralex91/Razzia — MIT, ~950 stars, created January 2024, rebranded from Rahoot at v3.0.0. React + TypeScript self-hosted quiz platform for smaller events: manager password, room codes, Docker Compose deploy. Actively developed and genuinely easy to run, which makes it the closest OSS proxy for how buyers already consume engagement software — but it is quiz-shaped, with no real-time 3D action, no game depth, and minimal ops features beyond Docker.

## 4. Positioning recommendations

1. **RECOMMENDED — Zero-build embeddable widget.** Package the Three.js client as one `<script type="module">` / iframe snippet with configurable branding, room codes, and postMessage score reporting. No competitor OSS game offers drop-in embedding; frameworks require building a game, proprietary platforms forbid or price it. This is Ashfall's sharpest wedge into marketing mini-games.
2. **RECOMMENDED — Self-host as a single Docker container.** One image serving client + game on :2567 with `/healthz` and `/metrics` contrasts directly with Agones' Kubernetes prerequisite and WorkAdventure's multi-service compose stack. "Runs on any VM with Docker in five minutes" is a procurement-friendly sentence none of the serious competitors can say.
3. **RECOMMENDED — OIDC/SSO plus Prometheus hooks.** Enterprises gate adoption on identity integration (Azure AD/Okta via OIDC) and observability (Prometheus/Grafana). Nakama and Agones have auth/metrics primitives but no game; Kahoot/Gather keep data in their cloud; ClassQuiz already ships OpenID login, showing even quiz-tier OSS meets this bar. Shipping OIDC sign-in and documented metric labels turns Ashfall into infrastructure their security review can approve.
4. **NICE-TO-HAVE — White-label theming.** Design-token-driven skins (logos, colors, class names, card art packs, CC0 pipeline already supports swapping assets) mirror what Gather and Kahoot charge premium tiers for. Valuable for sales, but sequence it after the widget and self-host stories since it is cosmetic relative to delivery and compliance gaps.
5. **NICE-TO-HAVE — Deterministic replay and anti-cheat evidence.** Server authority already gives Ashfall an integrity story P2P platforms cannot match. Recording ordered inputs per tick to produce replay files and audit logs makes branded competitions with prizes defensible. High engineering cost, so schedule after the RECOMMENDED bets, but market it early because no listed competitor can copy it cheaply.

## 5. Risks and blockers

- **No top-level LICENSE file (blocker, fix first).** Without a license the default copyright applies: enterprises legally cannot redistribute, embed, or modify Ashfall, and procurement will bounce it instantly. Recommend Apache-2.0 (explicit patent grant appeals to corporate counsel) or MIT (maximum simplicity). Add NOTICE/third-party attributions consistent with the CC0 asset pipeline.
- **Single-process scaling ceiling.** One Node.js process serves client and game; Colyseus rooms help within a process but vertical scale ends around a few hundred concurrent players per box, whereas Agones exists precisely to fleet-scale dedicated servers. Mitigations: document realistic concurrency, run N containers behind a load balancer with sticky room routing, keep the door open for an Agones adapter as the enterprise tier.
- **JSON-file persistence limits.** Per-player JSON files break under concurrent writes, offer no atomicity, no queries, no backup story, and prevent multi-node deployments. Migrate to SQLite by default with an optional Postgres driver, keeping JSON export/import for portability.
- **CDN importmap dependency.** Air-gapped enterprise networks block CDNs; vendor the Three.js/importmap assets so fully-offline deploys work (the offline solo fallback helps but does not cover multiplayer).
- **Secondary risks:** bus factor of a single-maintainer repo (mitigate with CONTRIBUTING.md, CI, tagged releases); trademark clearance on the Ashfall name before marketing pushes; GDPR/COPPA handling for event attendee data (no personal data retention by default); WebGL2 availability on locked-down corporate machines (provide graceful-degradation messaging).

### 5.1 Suggested remediation order

1. Add LICENSE (Apache-2.0 recommended) + NOTICE — one day, unblocks everything downstream.
2. SQLite persistence driver with JSON import/export — one to two weeks.
3. OIDC sign-in + documented `/metrics` labels — two weeks.
4. Embeddable widget mode (script tag + postMessage scores) — two to three weeks.
5. Multi-process scale path (N containers + sticky routing), then optional Agones adapter — ongoing.
6. White-label design tokens and replay/audit log — scheduled after revenue signals.

---

Sources: GitHub repository metadata and project sites verified via web search, August 2026 (colyseus.io, heroiclabs.com, agones.dev, open-match releases, trystero.dev, geckos.io/npm, mirror-networking.com, workadventu.re FAQ on licensing, classquiz.de docs, Razzia/Rahoot release notes, DarkRewar LICENCE.md, luanti.org rename announcement, veloren.net). Star counts rounded; treat as order-of-magnitude.
