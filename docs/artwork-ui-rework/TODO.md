# Artwork rework + UI revamp — tracking

Goal: agent-driven free-3D-asset pipeline + full UI revamp. TDD where testable.
Research: see RESEARCH.md in this directory.

## Phase R — Research
- [x] R1 Survey CC0/CC-BY sources (Kenney, Quaternius, Poly Pizza, Poly Haven, Sketchfab)
- [x] R2 Map download APIs + auth requirements
- [x] R3 Decide pipeline design (manifest-driven fetch-assets.mjs)
- [x] R4 RESEARCH.md committed to docs/artwork-ui-rework/

## Phase A — Asset pipeline (TDD)
- [ ] A1 RED: test/asset-pipeline.test.mjs — manifest planning, path safety,
      GLB magic-byte validation, credits row generation, size budget
- [ ] A2 GREEN: src/tools/assetPipeline.js pure logic module passes tests
- [ ] A3 tools/fetch-assets.mjs CLI wrapper (fetch layer: polyhaven keyless,
      polypizza keyed, kenney pinned zip) + tools/asset-manifest.json
- [ ] A4 Live download run: grass tuft, flowers, tree, rock variants into
      assets/props/ + credits rows updated in same change
- [ ] A5 Browser harness check: assets load via GLTFLoader without console errors

## Phase U — UI revamp
- [ ] U1 Inventory every id/class hook JS queries (contract list)
- [ ] U2 Design tokens: palette, type scale, spacing, radii as CSS custom props
- [ ] U3 Restyle login screen (hero card, char/mode picker cards, button states)
- [ ] U4 Restyle HUD (hp/cooldown bars, leaderboard, net badge, countdown)
- [ ] U5 Restyle overlays (upgrade, shop, gameover, reconnect) + touch controls
- [ ] U6 Verify live at localhost:2567: screenshots login + gameplay, zero
      console errors, all flows still work (join -> wave -> upgrade)

## Rules
- No emojis anywhere; no API keys in code (POLY_PIZZA_API_KEY from env only).
- Client-side visuals only; server sim untouched.
- Every element id the JS queries must survive the UI revamp.
