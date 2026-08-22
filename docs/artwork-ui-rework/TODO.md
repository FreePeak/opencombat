# Artwork rework + UI revamp — tracking

Goal: agent-driven free-3D-asset pipeline + full UI revamp. TDD where testable.
Research: see RESEARCH.md in this directory.

## Phase R — Research
- [x] R1 Survey CC0/CC-BY sources (Kenney, Quaternius, Poly Pizza, Poly Haven, Sketchfab)
- [x] R2 Map download APIs + auth requirements
- [x] R3 Decide pipeline design (manifest-driven fetch-assets.mjs)
- [x] R4 RESEARCH.md committed to docs/artwork-ui-rework/

## Phase A — Asset pipeline (TDD)
- [x] A1 RED: test/asset-pipeline.test.mjs — manifest planning, path safety,
      GLB magic-byte validation, credits row generation, size budget
- [x] A2 GREEN: src/tools/assetPipeline.js pure logic module passes tests
      (plus test/asset-pipeline-direct.test.mjs for pinned keyless CDN urls)
- [x] A3 tools/fetch-assets.mjs CLI wrapper + tools/asset-manifest.json
- [x] A4 Live download run: 7 Quaternius-style GLBs into assets/props/
      (grass_tuft_a/b, grass_tall, flowers_patch, bush_a CC-BY, bushes_patch,
      small_plant) + credits.csv / metadata.json updated in same change.
      Rejected: Poly-by-Google stump scan + Zsky flower (style clash),
      Poly Haven pine_tree_01 (~900 MB bundle).
- [x] A5 Browser harness check: all 7 parse via three r185 GLTFLoader,
      155-1360 tris each, zero console errors

## Phase W — World wiring
- [x] W1 src/tools/scatter.js: pure LCG sampler + fitScale (test/scatter.test.mjs)
- [x] W2 src/client/NatureDressing.js: instanced scatter of the GLB set into
      arenaGroup (seed 9021, independent of GameScene's 4242 stream; shared
      geo/mat flagged so enterWorld teardown skips them)
- [x] W3 main.js hook after scene.init(); verified live: 17 InstancedMeshes /
      368 instances, zero page errors

## Phase U — UI revamp
- [x] U1 Inventory every id/class hook JS queries (contract list)
- [x] U2 Design tokens: palette, type scale, spacing, radii as CSS custom props
- [x] U3 Restyle login screen (hero card, char/mode picker cards, button states)
- [x] U4 Restyle HUD (hp/cooldown bars, leaderboard, net badge, countdown)
- [x] U5 Restyle overlays (upgrade, shop, gameover, reconnect) + touch controls
- [x] U6 Server restarted 2026-08-22: stale process (boot-cached index.html) killed,
      fresh `npm run serve` up on :2567. Served HTML verified: design tokens present
      (`--accent-deep` x3), live-reload script injected, http.js mtime guard active.
      Endpoints 200: / , /env.js , /healthz , /src/main.js ,
      /src/client/NatureDressing.js , /assets/props/bush_a.glb.
      Remaining (manual, user): login + gameplay screenshots on served CSS and a
      join -> wave -> upgrade click-through. Runtime-injection preview already
      confirmed rendering: ui-login-preview.png.

## Rules
- No emojis anywhere; no API keys in code (POLY_PIZZA_API_KEY from env only).
- Client-side visuals only; server sim untouched.
- Every element id the JS queries must survive the UI revamp.
