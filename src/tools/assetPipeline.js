// Pure logic for tools/fetch-assets.mjs — no node builtins, no network.
// Kept dependency-free so both node --test and browser harnesses can import
// it directly (the repo has no bundler; everything is plain ESM).

/** glTF binary magic: 0x67 0x6C 0x54 0x46 ("glTF"). */
export function validateGlb(bytes) {
  if (!bytes || bytes.length < 4) return false;
  return bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

/**
 * Normalize + safety-check an output path from the manifest.
 * Must be repo-relative, stay under the root, and contain no NUL bytes.
 * Throws on anything that could escape assets/.
 */
export function safeOutPath(out) {
  if (typeof out !== 'string' || out.length === 0) throw new Error('empty out path');
  if (out.includes('\0')) throw new Error('NUL byte in path: ' + out);
  if (out.startsWith('/')) throw new Error('absolute out path: ' + out);
  const parts = out.split('/');
  for (const part of parts) {
    if (part === '..') throw new Error('path escape: ' + out);
  }
  return parts.filter((p) => p !== '' && p !== '.').join('/');
}

/**
 * Decide what to fetch. existing = list of files already on disk.
 * budgetBytes (optional): refuse to plan downloads past the ARTWORK_PLAN
 * 2 MB budget; avgBytes estimates each download when actual sizes are unknown.
 */
export function planDownloads(manifest, { existing = [], force = false, budgetBytes = Infinity, avgBytes = 500_000 } = {}) {
  const have = new Set(existing.map(safeOutPath));
  const toFetch = [];
  const skipped = [];
  let plannedBytes = 0;
  let overBudget = false;
  for (const entry of manifest) {
    const out = safeOutPath(entry.out);
    if (!force && have.has(out)) { skipped.push(out); continue; }
    if (plannedBytes + avgBytes > budgetBytes) { overBudget = true; break; }
    plannedBytes += avgBytes;
    toFetch.push({ ...entry, out });
  }
  return { toFetch, skipped, overBudget };
}

/**
 * Resolve the first URL to hit for a manifest entry.
 * polyhaven: keyless files API. polypizza: search API, requires env key.
 * kenney: pinned zip URL from the manifest. Returns null when unresolvable
 * (e.g. missing POLY_PIZZA_API_KEY) — callers report and skip.
 */
export function resolveSourceUrl(entry, env = {}) {
  switch (entry.source) {
    case 'polyhaven':
      return 'https://api.polyhaven.com/files/' + encodeURIComponent(entry.havenId);
    case 'polypizza': {
      const key = env.POLY_PIZZA_API_KEY;
      if (!key) return null;
      return 'https://api.poly.pizza/v1/search?q=' + encodeURIComponent(entry.query) + '&limit=5';
    }
    case 'kenney':
    case 'direct': // pinned CDN URL captured from a poly.pizza model page
      return entry.url || null;
    default:
      return null;
  }
}

/** One CSV row matching assets/credits/credits.csv's schema, RFC-quoted. */
export function creditsRow({ file, notes, authors, license, url }) {
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  return [q(file), q(notes), q(authors), q(license), q(url)].join(',');
}

/** Append an asset entry to the credits metadata doc (pure: returns a copy). */
export function mergeMetadata(doc, asset) {
  return {
    ...doc,
    assets: [
      ...doc.assets,
      {
        name: asset.name,
        author: asset.author,
        source: asset.url,
        license: asset.license,
        file: asset.file,
        role: asset.role,
        animations: asset.animations || []
      }
    ]
  };
}

export function totalSize(buffers) {
  return buffers.reduce((sum, b) => sum + (b ? b.byteLength : 0), 0);
}
