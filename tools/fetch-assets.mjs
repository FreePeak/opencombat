#!/usr/bin/env node
// Manifest-driven downloader for free 3D assets (see docs/artwork-ui-rework/RESEARCH.md).
//
// Usage:
//   node tools/fetch-assets.mjs            # fetch what is missing
//   node tools/fetch-assets.mjs --force    # refetch everything in the manifest
//   POLY_PIZZA_API_KEY=... node tools/fetch-assets.mjs   # enable poly.pizza entries
//
// Sources (all free):
//   polyhaven  keyless files API, CC0, downloads a .gltf bundle + textures
//   polypizza  search API, needs POLY_PIZZA_API_KEY env var (never hardcode it)
//   kenney     pinned zip URL from the manifest (CC0)
//
// Every successful download appends rows to assets/credits/credits.csv and
// assets/credits/metadata.json in the same run (license-drift guard,
// ARTWORK_PLAN.md section 7). Idempotent: entries whose output already exists
// are skipped unless --force.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planDownloads,
  safeOutPath,
  resolveSourceUrl,
  creditsRow,
  mergeMetadata
} from '../src/tools/assetPipeline.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'tools', 'asset-manifest.json');
const CREDITS_CSV = join(ROOT, 'assets', 'credits', 'credits.csv');
const CREDITS_JSON = join(ROOT, 'assets', 'credits', 'metadata.json');

async function listExisting(dir, acc = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e.name).slice(ROOT.length + 1);
    if (e.isDirectory()) await listExisting(join(dir, e.name), acc);
    else acc.push(p);
  }
  return acc;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return Buffer.from(await res.arrayBuffer());
}

/** Download one Poly Haven asset bundle (.gltf + include textures) into outDir. */
async function fetchPolyhaven(entry) {
  const filesUrl = resolveSourceUrl(entry, process.env);
  const meta = JSON.parse((await download(filesUrl)).toString('utf8'));
  const tier = meta.gltf && meta.gltf[entry.res || '1k'];
  if (!tier || !tier.gltf) throw new Error('no gltf ' + (entry.res || '1k') + ' for ' + entry.havenId);
  const spec = tier.gltf;
  const written = [];
  const mainName = entry.havenId + '.gltf';
  await mkdir(join(ROOT, entry.out), { recursive: true });
  await writeFile(join(ROOT, entry.out, mainName), await download(spec.url));
  written.push(entry.out + '/' + mainName);
  for (const [relPath, inc] of Object.entries(spec.include || {})) {
    const dest = safeOutPath(entry.out + '/' + relPath);
    await mkdir(dirname(join(ROOT, dest)), { recursive: true });
    await writeFile(join(ROOT, dest), await download(inc.url));
    written.push(dest);
  }
  return { written, url: 'https://polyhaven.com/a/' + entry.havenId };
}

async function fetchPolypizza(entry) {
  const searchUrl = resolveSourceUrl(entry, process.env);
  if (!searchUrl) throw new Error('POLY_PIZZA_API_KEY not set - skipping ' + entry.id);
  const hits = JSON.parse((await download(searchUrl)).toString('utf8'));
  const hit = (hits.models || hits.m || [])[0];
  if (!hit || !hit.download) throw new Error('no poly.pizza hit for ' + entry.query);
  const bytes = await download(hit.download);
  if (!(bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46)) {
    throw new Error('not a GLB: ' + entry.id);
  }
  const dest = safeOutPath(entry.out.endsWith('.glb') ? entry.out : entry.out + '.glb');
  await mkdir(dirname(join(ROOT, dest)), { recursive: true });
  await writeFile(join(ROOT, dest), bytes);
  return { written: [dest], url: hit.url || 'https://poly.pizza' };
}

async function fetchKenney(entry) {
  throw new Error('kenney zips need manual unzip - pin individual GLBs or extend this tool: ' + entry.id);
}

const FETCHERS = { polyhaven: fetchPolyhaven, polypizza: fetchPolypizza, kenney: fetchKenney };

const force = process.argv.includes('--force');
const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const existing = await listExisting(join(ROOT, 'assets'));
const plan = planDownloads(manifest.assets, {
  existing, force, budgetBytes: manifest.budgetBytes ?? Infinity, avgBytes: 1_500_000
});

console.log('plan:', plan.toFetch.length, 'to fetch,', plan.skipped.length, 'skipped' +
  (plan.overBudget ? ', BUDGET TRUNCATED (raise budgetBytes)' : ''));

let failures = 0;
for (const entry of plan.toFetch) {
  try {
    const { written, url } = await FETCHERS[entry.source](entry);
    console.log('ok  -', entry.id, '(' + written.length + ' files)');
    // Credits in the same run as the download (ARTWORK_PLAN rule).
    const row = creditsRow({
      file: written[0],
      notes: entry.role || entry.id,
      authors: entry.author,
      license: entry.license,
      url
    });
    const csv = await readFile(CREDITS_CSV, 'utf8');
    if (!csv.includes(written[0])) await writeFile(CREDITS_CSV, csv.replace(/\n?$/, '') + '\n' + row + '\n');
    const metaDoc = JSON.parse(await readFile(CREDITS_JSON, 'utf8'));
    if (!metaDoc.assets.some((a) => a.file === written[0])) {
      await writeFile(CREDITS_JSON, JSON.stringify(
        mergeMetadata(metaDoc, {
          name: entry.id, author: entry.author, license: entry.license,
          file: written[0], role: entry.role, animations: [], url
        }), null, 2) + '\n');
    }
  } catch (err) {
    failures++;
    console.error('FAIL-', entry.id, ':', err.message);
  }
}
if (failures) { console.error(failures + ' asset(s) failed'); process.exit(1); }
console.log('done');
