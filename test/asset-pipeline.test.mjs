// Unit tests for the asset download pipeline's pure logic (no network).
// Run: npm test  (node --test)
// The network layer lives in tools/fetch-assets.mjs; everything testable
// without sockets is extracted into src/tools/assetPipeline.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  planDownloads,
  validateGlb,
  safeOutPath,
  resolveSourceUrl,
  creditsRow,
  mergeMetadata,
  totalSize
} from '../src/tools/assetPipeline.js';
import { extractZipMembers } from '../src/tools/zipExtract.js';

/** Build an in-memory zip fixture with stored + deflated members. */
function makeZip(members) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  for (const [name, bytes, method] of members) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = method === 8 ? deflateRawSync(bytes) : bytes;
    const crc = crc32(bytes);
    const local = Buffer.from([
      0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(method),
      ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(bytes.length),
      ...u16(nameBytes.length), ...u16(0), ...nameBytes
    ]);
    chunks.push(local, data);
    central.push({
      nameBytes, crc, csize: data.length, usize: bytes.length,
      method, offset
    });
    offset += local.length + data.length;
  }
  let cdStart = offset;
  const cdChunks = [];
  for (const e of central) {
    cdChunks.push(Buffer.from([
      0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0),
      ...u16(e.method), ...u16(0), ...u16(0), ...u32(e.crc),
      ...u32(e.csize), ...u32(e.usize), ...u16(e.nameBytes.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(e.offset),
      ...e.nameBytes
    ]));
    cdStart += 46 + e.nameBytes.length;
  }
  const cdSize = cdChunks.reduce((s, c) => s + c.length, 0);
  chunks.push(...cdChunks, Buffer.from([
    0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length), ...u32(cdSize),
    ...u32(cdStart - cdSize), ...u16(0)
  ]));
  return Buffer.concat(chunks);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const MANIFEST = [
  { id: 'grass-tuft', source: 'polyhaven', havenId: 'grass_01', out: 'assets/props/grass_tuft.glb', license: 'CC0 1.0', author: 'Poly Haven' },
  { id: 'pine-tree', source: 'polypizza', query: 'low pine tree', out: 'assets/props/tree_pine.glb', license: 'CC0 1.0', author: 'Quaternius' },
  { id: 'rock-big', source: 'kenney', url: 'https://example.com/pack.zip', member: 'rock_big.glb', out: 'assets/props/rock_big.glb', license: 'CC0 1.0', author: 'Kenney' }
];

test('planDownloads fetches missing assets and skips existing ones', () => {
  const plan = planDownloads(MANIFEST, { existing: ['assets/props/grass_tuft.glb'] });
  assert.deepEqual(plan.toFetch.map((e) => e.id), ['pine-tree', 'rock-big']);
  assert.deepEqual(plan.skipped, ['assets/props/grass_tuft.glb']);
});

test('planDownloads with force refetches everything', () => {
  const plan = planDownloads(MANIFEST, {
    existing: ['assets/props/grass_tuft.glb'],
    force: true
  });
  assert.equal(plan.toFetch.length, 3);
  assert.deepEqual(plan.skipped, []);
});

test('planDownloads flags plans that exceed the size budget', () => {
  // Budget smaller than one estimated download -> nothing may be fetched.
  const plan = planDownloads(MANIFEST, { existing: [], budgetBytes: 100, avgBytes: 1000 });
  assert.deepEqual(plan.toFetch, []);
  assert.equal(plan.overBudget, true);
});

test('planDownloads keeps fetching while under budget and reports truncation', () => {
  const plan = planDownloads(MANIFEST, { existing: [], budgetBytes: 2500, avgBytes: 1000 });
  assert.equal(plan.toFetch.length, 2); // 2 x 1000 <= 2500, third would exceed
  // overBudget means "the manifest did not fully fit" - 1 of 3 was cut.
  assert.equal(plan.overBudget, true);
});

test('validateGlb accepts only glTF binary magic', () => {
  const good = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3]);
  assert.equal(validateGlb(good), true);
  assert.equal(validateGlb(new Uint8Array([0, 1, 2])), false);
  assert.equal(validateGlb(new Uint8Array(0)), false);
  assert.equal(validateGlb(null), false);
});

test('safeOutPath allows repo-relative asset paths and rejects escape attempts', () => {
  assert.equal(safeOutPath('assets/props/tree.glb'), 'assets/props/tree.glb');
  assert.throws(() => safeOutPath('../evil.glb'));
  assert.throws(() => safeOutPath('/etc/passwd'));
  assert.throws(() => safeOutPath('assets/../../evil.glb'));
  assert.throws(() => safeOutPath('assets/x.glb\0'));
});

test('resolveSourceUrl builds keyless Poly Haven URLs', () => {
  const url = resolveSourceUrl({ source: 'polyhaven', havenId: 'rock_wall' }, {});
  assert.equal(url, 'https://api.polyhaven.com/files/rock_wall');
});

test('resolveSourceUrl requires POLY_PIZZA_API_KEY for poly pizza', () => {
  assert.equal(resolveSourceUrl({ source: 'polypizza', query: 'tree' }, {}), null);
  const url = resolveSourceUrl({ source: 'polypizza', query: 'tree' }, { POLY_PIZZA_API_KEY: 'k' });
  assert.ok(url.startsWith('https://api.poly.pizza/v1/search?q=tree'));
});

test('resolveSourceUrl passes kenney pinned urls through', () => {
  const url = resolveSourceUrl({ source: 'kenney', url: 'https://example.com/a.zip' }, {});
  assert.equal(url, 'https://example.com/a.zip');
});

test('creditsRow emits quoted CSV matching the existing credits.csv schema', () => {
  const row = creditsRow({
    file: 'assets/props/a.glb', notes: 'a "nice" prop',
    authors: 'Quaternius', license: 'CC0 1.0', url: 'https://poly.pizza/m/x'
  });
  assert.equal(row, '"assets/props/a.glb","a ""nice"" prop","Quaternius","CC0 1.0","https://poly.pizza/m/x"');
});

test('mergeMetadata appends an asset and preserves existing entries', () => {
  const doc = { project: 'p', assets: [{ name: 'Tree', file: 'assets/props/tree.glb' }] };
  const out = mergeMetadata(doc, {
    name: 'Grass Tuft', author: 'Poly Haven', license: 'CC0 1.0',
    file: 'assets/props/grass_tuft.glb', role: 'arena dressing', animations: []
  });
  assert.equal(out.assets.length, 2);
  assert.equal(out.assets[0].name, 'Tree');
  assert.equal(out.assets[1].file, 'assets/props/grass_tuft.glb');
  assert.deepEqual(out.assets[1].animations, []);
});

test('totalSize sums byte lengths of downloaded buffers', () => {
  assert.equal(totalSize([new Uint8Array(10), new Uint8Array(5)]), 15);
});

// --- zip extraction (kenney pinned packs) --------------------------------

const GLB_MAGIC = Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);

test('extractZipMembers inflates deflated members from a zip archive', () => {
  const zip = makeZip([
    ['Models/GLTF format/tree.glb', GLB_MAGIC, 8],
    ['readme.txt', Buffer.from('hello kenney'), 8]
  ]);
  const out = extractZipMembers(zip, ['Models/GLTF format/tree.glb']);
  assert.equal(out.size, 1);
  assert.ok(validateGlb(out.get('Models/GLTF format/tree.glb')));
});

test('extractZipMembers reads stored (method 0) members', () => {
  const zip = makeZip([['a/grass.glb', GLB_MAGIC, 0]]);
  const out = extractZipMembers(zip, ['a/grass.glb']);
  assert.equal(out.get('a/grass.glb').length, GLB_MAGIC.length);
  assert.ok(validateGlb(out.get('a/grass.glb')));
});

test('extractZipMembers extracts several members in one pass', () => {
  const zip = makeZip([
    ['m/rock.glb', GLB_MAGIC, 8],
    ['m/stump.glb', GLB_MAGIC, 0],
    ['m/ignored.png', Buffer.from([1, 2, 3]), 8]
  ]);
  const out = extractZipMembers(zip, ['m/rock.glb', 'm/stump.glb']);
  assert.deepEqual([...out.keys()].sort(), ['m/rock.glb', 'm/stump.glb']);
});

test('extractZipMembers throws on missing member names', () => {
  const zip = makeZip([['present.glb', GLB_MAGIC, 8]]);
  assert.throws(() => extractZipMembers(zip, ['missing.glb']), /missing\.glb/);
});

test('extractZipMembers rejects non-zip buffers', () => {
  assert.throws(() => extractZipMembers(Buffer.from('not a zip'), ['x']), /not a zip|EOCD/i);
});
