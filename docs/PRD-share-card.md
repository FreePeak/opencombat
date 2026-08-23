# PRD: Results Share Card (Cycle 21)

Status: SHIPPED cycle 21; IMAGE RENDERING shipped as follow-up cycle (see "Cycle: image rendering" below).

## Problem

Match endings produce no shareable artifact. The gameover overlay shows a
score line that dies with the session; players have no one-step way to post
their run (wave/score/streak/objectives) to friends or social channels. The
retention systems (daily/weekly gauntlets, objectives) all benefit from a
social loop this game currently lacks.

## Solution

A deterministic share-card composer plus a one-click SHARE action on the
gameover overlay:

- `src/shared/sim/shareCard.js` (new, zero imports): `buildShareCard(run)`
  where run = {mode, victory?, wave, score, name?, streak?, objectivesDone?,
  objectivesTotal?} -> `{headline, stats: [{label, value}], text}` —
  deterministic, mode-aware (waves/daily/weekly/arena), no DOM.
  `shareText(card)` renders the clipboard-ready multi-line string.
- GameScene: on match gameover, build the card from live state + persisted
  daily blob fields it already has; render a SHARE button into the gameover
  card; click copies `text` via navigator.clipboard with a COPIED ack
  (graceful no-op when clipboard unavailable).

## Out of scope

- Image/canvas rendering of the card (follow-up if wanted).
- Server-side share URLs / og-image endpoints.
- Any change to finalize/persistence behavior.

## Acceptance criteria

1. Card composition is deterministic: same run -> deep-equal card.
2. Mode-awareness: weekly cards carry objectivesDone/Total when present;
   daily carries streak; waves/arena omit challenge-specific lines.
3. Victory vs defeat headlines differ and are pinned per mode family.
4. `shareText` output contains every stat value exactly once and ends with
   the game name.
5. SHARE button appears only on the match-over overlay (not death/respawn),
   copies without throwing where clipboard exists.
6. Full gate green: `npm run check && npm test && npm run smoke`.

## Cycle: image rendering (follow-up, shipped)
Research basis: text-only shares underperform on Discord/X/mobile where image
posts dominate; the platform pattern is a rendered PNG card offered through
Web Share API Level 2 files (mobile share sheet), ClipboardItem image copy
(desktop), and plain-text fallback everywhere else. buildShareCard was built
deterministic in cycle 21 specifically to enable this.
- `layoutShareCard(card)` (pure, shareCard.js): deterministic pixel geometry +
  color data for an 800x450 card — title, stat rows at fixed x/y with distinct
  baselines, footer. No DOM; node tests pin deep-equal determinism, bounds,
  row spacing.
- `chooseShareMode({canShareFiles, clipboardImage})` (pure): 'native' |
  'image' | 'text' — capability ladder resolved once, tested without mocks.
- GameScene `_renderShareCanvas()`: thin offscreen-canvas renderer consuming
  layoutShareCard verbatim (draw-only, zero layout logic); SHARE click walks
  the chosen mode: navigator.share({files:[png]}) -> ClipboardItem png copy
  (ack IMAGE COPIED) -> existing text copy (ack COPIED).
- Out of scope: server og-image endpoints, per-mode art themes.
- AC1 layoutShareCard same card -> deep-equal layout; every stat appears as a
  row inside canvas bounds, distinct y. AC2 chooser maps all 4 boolean combos
  correctly. AC3 client renderer draws only from layout fields (code review).
  AC4 full gate green.
