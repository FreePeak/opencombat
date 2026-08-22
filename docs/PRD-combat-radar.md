# PRD: Combat Radar (Cycle 19)

Status: PLANNED (cycle 19)

## Problem

Match rooms (waves/daily/weekly) render enemies only within the camera
frustum. Off-screen threats — especially Rushers closing from behind and
Shooter arrows sourced outside the view — arrive with no spatial warning.
World mode has a chunk minimap (`src/ui/Minimap.js`); match modes have no
situational-awareness surface at all.

## Solution

A compact HUD radar for match rooms: a fixed-position canvas showing the full
square arena (world size 60 -> half-extent 30), with enemy blips (red), ally
blips (player tints), and the local player (white ring). Projection math lives
in a pure shared/sim module so it is headlessly testable and reusable.

## Scope

- `src/shared/sim/radar.js` (new, zero imports): `projectRadar(entities,
  self, half)` -> `[{ u, v, clamped }]` where `{u,v}` are canvas-normalized
  [0,1] coordinates relative to a radar centered on SELF (self always maps to
  center 0.5,0.5), and `clamped` marks blips pushed onto the radar rim when
  they exceed the visible span. Deterministic, no DOM.
- `src/ui/CombatRadar.js` (new, mirror of Minimap's canvas pattern): renders
  arena frame, blips from `projectRadar`, self ring/crosshair; `update()`
  reads room.state.players + scene enemies; `dispose()` removes the node.
- `src/scenes/GameScene.js`: instantiate/update/dispose the radar for
  non-world matches (waves/daily/weekly/arena), hidden during menu states.
- Tests (`test/radar.test.mjs`, red-first): center/corner projection exactness,
  symmetric span math, rim clamping for out-of-span positions, empty input,
  determinism across calls.

## Out of scope

- World mode (its chunk minimap stays authoritative there).
- Any sim/state change on GameRoom or LocalRoom — radar consumes the same
  synced x/z fields both rooms already publish; client-render only.
- Fog-of-war / stream-snipe countermeasures (separate idea).

## Acceptance criteria

1. Self at any world position projects to exactly (0.5, 0.5).
2. A point `half` units away on an axis projects to the corresponding edge
   (0 or 1) within tolerance; points beyond are clamped with `clamped: true`.
3. Projection is deterministic and side-effect free.
4. Radar appears during live matches in waves/daily/weekly modes and is
   removed on return to menu; world mode unaffected.
5. Full gate green: `npm run check && npm test && npm run smoke`.
