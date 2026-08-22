# PRD: Air-Gapped Asset Vendoring

Status: ACTIVE · Cycle 14 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
The client pulls three.js, three/addons and @colyseus/sdk from jsdelivr — deployments behind blocked outbound (or offline events) cannot boot the client. Roadmap 2.4.

## Solution
Vendor the exact pinned CDN files into `assets/vendor/` (committed), serve them from our own Express app at `/vendor/*`, and let env `VENDORED_ASSETS=1` rewrite the importmap + SDK script src to self-hosted URLs at serve time. Default remains CDN (zero change for current hosts).

## Scope
1. `tools/vendor-assets.mjs` (new): downloads the 4 pinned resources into assets/vendor/ with integrity check via content-length presence (idempotent; skips existing). Files:
   - three@0.185.1/build/three.module.js
   - three@0.185.1/examples/jsm/libs/... NOT needed — only addons actually imported; copy strategy: fetch `three/addons/` subtree is too broad — instead grep index.html+src for actual `three/addons/...` imports and fetch exactly those paths.
   - @colyseus/schema@4.0.13/build/index.mjs
   - @colyseus/sdk@0.17.43/dist/colyseus.js
   Run once now and COMMIT vendored files (air-gap = no download step at deploy).
2. http.js static route: when `process.env.VENDORED_ASSETS === '1'` serve `/vendor/*` from assets/vendor with correct MIME (js/mjs) + immutable cache header; else 404.
3. index.html served dynamically? It's static today. Minimal approach: keep index.html static but swap URLs client-side is impossible pre-importmap → so http.js intercepts `GET /` when VENDORED_ASSETS=1: read index.html, string-replace the 4 CDN URLs with `/vendor/...` equivalents (cache the rewritten string), serve that. Default path untouched byte-for-byte.
4. Tests (`test/vendored.test.mjs`): default mode serves original HTML containing cdn.jsdelivr.net; vendored mode (env flip like adminApi test pattern) serves rewritten HTML without any CDN reference AND /vendor/three.module.js responds 200 JS content-type matching bytes on disk; vendor manifest file lists expected files exist on disk.
5. Docs: README section "Offline deployment" — 3 lines (run tools script once, deploy with VENDORED_ASSETS=1).

## Out of scope
GLB texture vendoring (already local), SRI hashes, service-worker caching.

## Acceptance criteria
- AC1: Default serving unchanged (CDN strings present).
- AC2: Vendored mode: zero external URLs in served HTML; all four vendor files served 200 with JS MIME.
- AC3: Playwright e2e still GREEN in default mode; vendored-mode boot verified by node fetch of rewritten page + vendor file (full browser e2e optional if CI allows).
- AC4: Full gate green; smoke 8/8.

## Fan-out
Single agent (serving seam cohesion).
