// Career stats accumulator (PRD-career-stats.md): per-player lifetime record
// persisted under persistence.js (`career` key) and surfaced at match end.
// Pure module — no imports — mirroring elites/orbDrops/magnetPull so rooms,
// client and tests share ONE source of truth.
//
// Shape: { runs, victories, bestWave, bestScore }
//   - runs/victories are counters; best* are monotonic maxes
//   - recordRun NEVER mutates its input (callers own persistence copies)

function clampNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Fold one finished run into a career record.
 * @param {{runs,victories,bestWave,bestScore}|null} career - prior record
 * @param {{wave:number, score:number, victory:boolean}} run - finished run
 * @returns {{runs,victories,bestWave,bestScore}} new record
 */
export function recordRun(career, run) {
  const prev = career ?? { runs: 0, victories: 0, bestWave: 0, bestScore: 0 };
  const wave = clampNum(run?.wave);
  const score = clampNum(run?.score);
  return {
    runs: prev.runs + 1,
    victories: prev.victories + (run?.victory ? 1 : 0),
    bestWave: Math.max(prev.bestWave, wave),
    bestScore: Math.max(prev.bestScore, score),
  };
}
