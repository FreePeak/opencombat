// Results Share Card (PRD-share-card.md, Cycle 21): composes a deterministic,
// mode-aware summary of a finished run into {headline, stats, text} for the
// gameover SHARE button. Pure — zero imports, no DOM, no state; the same run
// always produces a deep-equal card so tests and future image rendering can
// pin it exactly.
//
// Consumers:
//   src/scenes/GameScene.js -> match-over overlay SHARE action
//   test/shareCard.test.mjs -> headless contract pin

const GAME_NAME = 'Ashfall';

const HEADLINES = {
  victory: 'VICTORY — THE HORDE IS BROKEN',
  win: 'YOU WIN',
  defeat: 'FALLEN IN THE ASHFALL',
};

/** Which optional stat lines each mode carries. */
function linesFor(mode) {
  switch (mode) {
    case 'daily': return ['streak'];
    case 'weekly': return ['objectives'];
    default: return [];
  }
}

/**
 * @param run {mode, victory?, wave, score, name?, streak?, objectivesDone?, objectivesTotal?}
 * @returns {headline, stats: [{label, value}], text}
 */
export function buildShareCard(run) {
  const r = run ?? {};
  const headline = r.victory === true ? HEADLINES.victory
    : r.mode === 'arena' && r.winner ? HEADLINES.win
    : HEADLINES.defeat;
  const stats = [
    { label: 'Mode', value: String(r.mode ?? 'waves').toUpperCase() },
    { label: 'Wave', value: r.wave ?? 0 },
    { label: 'Score', value: r.score ?? 0 },
  ];
  const extras = new Set(linesFor(r.mode));
  if (extras.has('streak') && r.streak != null) {
    stats.push({ label: 'Streak', value: r.streak });
  }
  if (extras.has('objectives') && r.objectivesTotal != null) {
    stats.push({ label: 'Objectives', value: `${r.objectivesDone ?? 0}/${r.objectivesTotal}` });
  }
  if (r.name) stats.push({ label: 'Player', value: r.name });
  return { headline, stats, text: null };
}

/** Clipboard-ready multi-line share string. */
export function shareText(card) {
  const rows = card.stats.map((s) => `${s.label}: ${s.value}`).join(' · ');
  return `${card.headline}\n${rows}\n${GAME_NAME}`;
}
