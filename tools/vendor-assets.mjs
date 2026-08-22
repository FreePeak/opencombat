#!/usr/bin/env node
// Air-gapped asset vendor (PRD-airgap-vendoring.md): downloads the pinned
// jsDelivr resources the client pulls today (index.html importmap + SDK
// script tag) into assets/vendor/, mirroring the CDN path shape so serving
// is a pure prefix swap (https://cdn.jsdelivr.net/X -> /vendor/X).
//
// Usage:
//   node tools/vendor-assets.mjs          # fetch what is missing (idempotent)
//   node tools/vendor-assets.mjs --force  # refetch everything
//
// The script greps index.html + the JS sources under src/ for ACTUAL
// `three/addons/...` imports (fetching the whole examples/jsm subtree is too broad) and then
// follows RELATIVE imports inside those addon files transitively, so the
// closure (Pass.js, shaders, etc.) is complete without hardcoding it.
//
// Every successful download appends to assets/vendor/manifest.json
// ({url -> {file, size}}); the size doubles as the light integrity check
// (content-length presence/match at download time). Run ONCE now and commit
// the results — air-gap means there is NO download step at deploy time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets', 'vendor');
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json');
const CDN = 'https://cdn.jsdelivr.net/';

// Pinned entrypoints exactly as referenced by index.html.
const PINNED = [
  `${CDN}npm/three@0.185.1/build/three.module.js`,
  `${CDN}npm/@colyseus/schema@4.0.13/build/index.mjs`,
  `${CDN}npm/@colyseus/sdk@0.17.43/dist/colyseus.js`
];

// `three/addons/<spec>` -> `npm/three@<ver>/examples/jsm/<spec>` (importmap
// trailing-slash mapping), discovered from real usage, not guessed.
const ADDONS_BASE = `${CDN}npm/three@0.185.1/examples/jsm/`;

/** Scan index.html + JS sources under src/ for bare `three/addons/...` specifiers. */
function discoverAddonUrls() {
  const specs = new Set();
  const scanFile = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/['"]three\/addons\/([^'"]+)['"]/g)) specs.add(m[1]);
  };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) scanFile(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  scanFile(path.join(ROOT, 'index.html'));
  return [...specs].sort().map((spec) => ADDONS_BASE + spec);
}

// Relative specifiers in ESM source: static/dynamic import + re-export.
const REL_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.\.?\/[^'"]+)['"]/g;

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const bytes = Buffer.from(await res.arrayBuffer());
  // Integrity check per PRD scope 1: content-length PRESENCE (+ non-empty
  // body). jsDelivr compresses in transit, so the declared length is the
  // compressed size and cannot be compared to the decompressed byte count.
  const declared = res.headers.get('content-length');
  if (!bytes.length) throw new Error('empty body: ' + url);
  if (declared === null || Number(declared) <= 0) {
    throw new Error('no content-length from CDN: ' + url);
  }
  return bytes;
}

const force = process.argv.includes('--force');
const queue = [...PINNED, ...discoverAddonUrls()];
const seen = new Set(queue);
const manifest = {};

let fetched = 0;
while (queue.length) {
  const url = queue.shift();
  const rel = url.slice(CDN.length); // e.g. npm/three@0.185.1/build/three.module.js
  if (!rel || rel.includes('..')) throw new Error('unsafe vendor path: ' + url);
  const dest = path.join(OUT_DIR, rel);
  if (!force && fs.existsSync(dest)) {
    console.log('skip-', rel, '(exists)');
  } else {
    const bytes = await download(url);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    fetched++;
    console.log('ok  -', rel, '(' + bytes.length + ' bytes)');
  }
  manifest[url] = { file: rel, size: fs.statSync(dest).size };
  // Follow relative imports ONLY inside the jsm subtree (closure discovery).
  if (rel.startsWith('npm/three@0.185.1/examples/jsm/')) {
    for (const m of fs.readFileSync(dest, 'utf8').matchAll(REL_SPEC)) {
      const abs = new URL(m[1], url).href;
      if (abs.startsWith(ADDONS_BASE) && !seen.has(abs)) {
        seen.add(abs);
        queue.push(abs);
      }
    }
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  'done:', fetched, 'fetched,', Object.keys(manifest).length, 'total;',
  'manifest ->', path.relative(ROOT, MANIFEST_PATH)
);
