# PRD: Wave Finale

Status: ACTIVE · Loop cycle D · 2026-08-22
Owner: infinite loop session (agent-driven)
Research basis: docs/vampire-survivors-research.md §2 lesson 12 ("session-length
honesty"), §6 idea #3
Depends on: nothing contested — one schema boolean, both advance paths,
client overlay text branch.

## Problem

Waves mode runs forever: no win, no arc, nothing shareable. VS lesson #12 —
a bounded run with an explicit climax makes victories legible and worth
posting (the daily gauntlet proves retention value of shareable endings,
but core waves lacks one).

## Solution

`SERVER.wave.finaleWave = 12` (0 = endless legacy). Clearing wave N ≥
finaleWave and advancing ENDS THE MATCH as a co-op VICTORY instead of
spawning wave N+1: `matchState 'gameover'` + new `WorldState.victory:true`,
winner fields left empty (co-op win belongs to everyone). Results overlay
reads "THE HORDE IS BROKEN — VICTORY!" via a client branch on `state.victory`;
defeat/death endings keep today's copy. `playAgain` resets through the
shared reset (victory:false restored).

## Scope

1. Config knob under existing `wave:` section.
2. StateSchema: `WorldState.victory: boolean` (default false).
3. GameRoom.startNextWave: guard before spawnWave — finale check routes to
   endMatch('') + victory=true (+ logEvent 'match_victory').
4. LocalRoom._requestNextWave: identical guard mirroring its own gameover
   transition (_matchEnded=true, _notifyStateChange).
5. matchPhases.resetMatchState: `state.victory = false` beside winner clears
   (both rooms' playAgain flows already call it).
6. GameScene gameover branch (~line 1395): victory text first.
7. Tests (waves.test.mjs): SERVER.wave.finaleWave temporarily 2 (config
   mutation precedent exists); drive two full clear→advance cycles; third
   advance asserts gameover+victory; playAgain restores playing+victory
   false; restore config in finally. LOCAL parity block mirrors via manual
   steps.

## Out of scope

Boss enemy at the finale (archetypes/elite composition already provide spike
pressure; dedicated boss = future cycle). Per-mode finale overrides (daily
inherits). Post-victory stats card beyond existing overlay fields.

## Acceptance criteria

- AC1: With finaleWave=N, clearing wave N and advancing ends the match with
  matchState 'gameover' AND victory true — in BOTH sims.
- AC2: finaleWave=0 preserves endless behavior (no trigger).
- AC3: playAfter victory: playAgain returns to playing with victory false.
- AC4: Death-based endings never set victory (flag only set on the finale
  advance path).
- AC5: Full gate green (check/test/smoke) + PROGRESS row.
