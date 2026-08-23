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

// --- Image rendering (PRD-share-card.md "Cycle: image rendering") ---

const LAYOUT = {
  w: 800, h: 450,
  bg: '#0b0e14', accent: '#4466aa', text: '#cfd8ea', dim: '#8a93a6',
  titleY: 96, titleSize: 34,
  firstRowY: 180, rowStep: 44,
  labelX: 48, valueX: 240, rowSize: 24, labelSize: 18,
  footerSize: 16,
};

/**
 * Deterministic pixel geometry + color data for the 800x450 share card.
 * Pure — returns plain data; the client canvas renderer draws it verbatim.
 * @returns {{w,h,bg,accent,text,dim,title:{text,x,y,size},
 *   rows:[{label,value,labelX,valueX,y,size}],
 *   footer:{text,x,y,size}}}
 */
export function layoutShareCard(card) {
  const c = card ?? { headline: '', stats: [] };
  return {
    w: LAYOUT.w, h: LAYOUT.h,
    bg: LAYOUT.bg, accent: LAYOUT.accent, text: LAYOUT.text, dim: LAYOUT.dim,
    title: { text: c.headline, x: LAYOUT.labelX, y: LAYOUT.titleY, size: LAYOUT.titleSize },
    rows: (c.stats ?? []).map((s, i) => ({
      label: s.label, value: s.value,
      labelX: LAYOUT.labelX, valueX: LAYOUT.valueX,
      y: LAYOUT.firstRowY + i * LAYOUT.rowStep,
      size: LAYOUT.rowSize,
    })),
    footer: {
      text: GAME_NAME, x: LAYOUT.w - LAYOUT.labelX - 60,
      y: LAYOUT.h - 32, size: LAYOUT.footerSize,
    },
  };
}

/**
 * Capability ladder for the SHARE action (resolved once per click).
 * native = Web Share API Level 2 files; image = ClipboardItem png copy;
 * text = plain-text clipboard fallback.
 */
export function chooseShareMode({ canShareFiles, clipboardImage }) {
  if (canShareFiles) return 'native';
  if (clipboardImage) return 'image';
  return 'text';
}
