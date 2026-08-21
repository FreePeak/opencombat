// Minimal ZIP reader for pinned Kenney packs (node-only: uses zlib).
// Parses the central directory, then reads local headers to locate member
// data. Supports method 0 (stored) and 8 (deflate) - all Kenney zips use
// these. Kept separate from assetPipeline.js so the pure module stays
// importable from browser harnesses.
import { inflateRawSync } from 'node:zlib';

const U16 = (b, o) => b[o] | (b[o + 1] << 8);
const U32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * Extract the named members of a zip buffer.
 * @param {Buffer} zip raw archive bytes
 * @param {string[]} names archive paths to extract (exact match)
 * @returns {Map<string, Buffer>} name -> decompressed bytes
 */
export function extractZipMembers(zip, names) {
  if (!zip || zip.length < 22 || !findEocd(zip)) {
    throw new Error('not a zip buffer (no EOCD)');
  }
  const eocd = findEocd(zip);
  const count = U16(zip, eocd + 10);
  let ptr = U32(zip, eocd + 16);
  const wanted = new Set(names);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (U32(zip, ptr) !== 0x02014b50) break;
    const method = U16(zip, ptr + 10);
    const csize = U32(zip, ptr + 20);
    const nameLen = U16(zip, ptr + 28);
    const extraLen = U16(zip, ptr + 30);
    const commentLen = U16(zip, ptr + 32);
    const localOffset = U32(zip, ptr + 42);
    const name = zip.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    if (wanted.has(name)) {
      // data offset comes from the LOCAL header's own lengths
      const lNameLen = U16(zip, localOffset + 26);
      const lExtraLen = U16(zip, localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = zip.subarray(dataStart, dataStart + csize);
      out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  for (const name of names) {
    if (!out.has(name)) throw new Error('member not found in zip: ' + name);
  }
  return out;
}

function findEocd(zip) {
  // EOCD is at least 22 bytes; comment may follow it.
  const min = zip.length - 22;
  for (let i = min; i >= Math.max(0, min - 65535); i--) {
    if (U32(zip, i) === 0x06054b50) return i;
  }
  return null;
}
