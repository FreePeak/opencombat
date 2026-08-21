// Deterministic scatter math for GLB nature dressing. Dependency-free so
// node --test can exercise it and every client computes identical placements
// (same rule as GameScene's seeded arena RNG — ARTWORK_PLAN section 7).

/** Same LCG family as GameScene's makeRng: deterministic across engines. */
export function makeLcg(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Sample count (x, z) points in [-half, half]^2, rejecting the spawn square
 * |x| < safe && |z| < safe. Mirrors the retry loop in GameScene.scatterProps.
 */
export function sampleOpenPositions(rng, count, half, safe) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    let x = 0, z = 0;
    for (let tries = 0; tries < 16; tries++) {
      x = -half + rng() * half * 2;
      z = -half + rng() * half * 2;
      if (Math.abs(x) >= safe || Math.abs(z) >= safe) break;
    }
    pts.push({ x, z });
  }
  return pts;
}

/**
 * Uniform scale that fits a model's world-space Y bbox to targetHeight.
 * maxScale caps pathological models (e.g. tiny scans blown up to 50x).
 */
export function fitScale(bbox, targetHeight, maxScale = Infinity) {
  const h = bbox.maxY - bbox.minY;
  if (!(h > 1e-4)) return 1;
  return Math.min(targetHeight / h, maxScale);
}
