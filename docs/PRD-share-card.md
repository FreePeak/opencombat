# PRD: Results Share Card (Cycle 21)

Status: PLANNED (cycle 21) — backlog #3 in docs/vampire-survivors-research.md §6.

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
