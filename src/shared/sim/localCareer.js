// Offline career checkpoints (P2.14): endless local play never fires
// endMatch, so progression needs per-wave checkpointing into localStorage.
// Pure module — a Storage-like (localStorage or an in-memory stub) is always
// injected so tests run headlessly.
//
// Shape kept SEPARATE from the server `career` record on purpose: offline has
// no victories concept (endless war), so this is {runs, bestWave, bestScore}.

export const LOCAL_CAREER_KEY = 'opengame.localCareer';

export function loadLocalCareer(storage) {
  try {
    const raw = storage?.getItem?.(LOCAL_CAREER_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || typeof rec !== 'object') return null;
    return {
      runs: Math.max(1, Number(rec.runs) || 1),
      bestWave: Math.max(0, Number(rec.bestWave) || 0),
      bestScore: Math.max(0, Number(rec.bestScore) || 0),
    };
  } catch {
    return null; // corrupt JSON: graceful reset
  }
}

export function saveLocalCareer(storage, rec) {
  try {
    storage?.setItem?.(LOCAL_CAREER_KEY, JSON.stringify(rec));
  } catch {
    /* quota/private-mode failures are non-fatal */
  }
}

// Fold one cleared wave into the record. Returns a NEW record (input untouched).
export function checkpointWave(prev, { wave = 0, score = 0 } = {}) {
  const base = prev ?? { runs: 1, bestWave: 0, bestScore: 0 };
  return {
    runs: base.runs,
    bestWave: Math.max(base.bestWave, Number(wave) || 0),
    bestScore: Math.max(base.bestScore, Number(score) || 0),
  };
}
