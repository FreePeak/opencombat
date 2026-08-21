# Research — free 3D assets + agent-driven download pipelines (2026-08-21)

Scope: how an autonomous agent can source free 3D game assets (characters,
grass, props) for opengame and revamp the UI. Client-side only; server sim
untouched.

## 1. Vetted free sources

| Source | License | Auth | Formats | Best for |
|--------|---------|------|---------|----------|
| Kenney (kenney.nl) | CC0 | none, direct zip links | glTF/GLB, FBX, OBJ | nature kits, characters, UI packs |
| Quaternius (quaternius.com) | CC0 | none, direct zips | GLB, FBX, OBJ | stylized low-poly characters/animals/nature |
| Poly Pizza (poly.pizza) | CC-BY / CC0 | API key (free) | GLB | search across Kenney+Quaternius+community, single-model fetch |
| Poly Haven (polyhaven.com) | CC0 | none, public API | GLTF + textures, HDRIs | ground textures, HDRIs, props |
| OpenGameArt | mixed CC0/CC-BY/GPL | none | varies | fallback, license audit needed per file |
| Sketchfab | per-model CC | OAuth token required | glTF | last resort (auth friction) |

Style rule from ARTWORK_PLAN.md risk table: only Quaternius/Kenney-style flat
low-poly; reject realistic assets to avoid style clash.

## 2. Programmatic download APIs (agent automation)

### Poly Pizza (primary search index)
- Search: GET https://api.poly.pizza/v1/search?q=tree&limit=20
  header: x-api-key: $POLY_PIZZA_API_KEY (free key from poly.pizza/dashboard)
- Download: response m[].Download or GET /v1/model/{id}/download?format=glb
- Returns direct GLB URLs -> stream to assets/.
- No key? Fallback below.

### Poly Haven (no auth at all)
- Asset list: GET https://api.polyhaven.com/assets?t=models
- Files: GET https://api.polyhaven.com/files/{id} -> gltf entry lists the
  .gltf plus every include-* texture with direct CDN URLs.
- Fully scriptable without keys; ideal default.

### Kenney (direct zips)
- Pack pages expose https://kenney.nl/media/pages/assets/<pack>/<hash>/<file>.zip
- Stable enough to pin in a manifest; unzip client-side (unzip tooling) and
  copy needed GLBs. All CC0.

### Sketchfab
- GET api.sketchfab.com/v3/models/{uid}/download with Authorization: Token ...
- Two-step (request then temp URL), OAuth friction -> keep out of default path.

## 3. Recommended pipeline for this repo

tools/fetch-assets.mjs:
1. PLAN: read tools/asset-manifest.json (asset id -> {source, query|url, out,
   license, author}). Pure function -> unit-testable.
2. FETCH: download each entry (Poly Haven first: no key; Poly Pizza when
   POLY_PIZZA_API_KEY set; Kenney pinned zips as curated fallback).
3. VERIFY: non-empty, magic bytes glTF (glTF binary header "glTF"), size budget
   (ARTWORK_PLAN: 2 MB total).
4. CREDITS: append rows to assets/credits/metadata.json + credits.csv in the
   same run (license drift guard from ARTWORK_PLAN section 7).
5. IDEMPOTENT: skip files already present unless --force.

TDD split: planning/credits/path-safety logic is pure JS tested by
test/asset-pipeline.test.mjs via node --test; network layer is thin and
manually verified once (browser harness can import the same module).

## 4. UI revamp approach

index.html owns all UI as DOM overlays (login, HUD, leaderboard, countdown,
gameover, upgrade/shop overlays, touch controls). Revamp = new design system
in that stylesheet only: CSS custom properties (palette, spacing, radii),
one accent ramp, panel/glass surfaces, consistent type scale, focus states.
Constraint: preserve every element id/class hook the JS queries (ids are the
contract); visual-only changes so no simulation risk. Verified live at
http://localhost:2567 with screenshots + zero console errors.

## 5. Decision

Adopt Poly Haven (default, keyless) + Poly Pizza (search breadth, keyed) +
Kenney pinned zips (curated packs) behind one manifest-driven downloader;
procedural fallbacks stay where downloads fail. UI revamp is pure-CSS on
existing DOM contract.
