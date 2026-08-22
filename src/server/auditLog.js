// Append-only admin audit trail (PRD-admin-api.md): one JSON line per admin
// action in `data/audit.jsonl` — {ts, actor:'admin', action, target, outcome}.
// Pure-ish by design (fs + path only, no room imports): appendFileSync for
// writes, a bounded tail read for the GET /api/admin/audit endpoint.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const auditFile = path.resolve(root, 'data/audit.jsonl');

/** Append one audit entry as a single JSON line. */
export function appendAudit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), actor: 'admin', ...entry });
  try {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(auditFile, line + '\n', 'utf8');
  } catch {} // auditing must never break the request path
}

/** Last `n` parsed audit lines (oldest first), [] when the log is absent. */
export function readTail(n) {
  let text = '';
  try {
    text = fs.readFileSync(auditFile, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const tail = lines.slice(-Math.max(0, n));
  const parsed = [];
  for (const line of tail) {
    try {
      parsed.push(JSON.parse(line));
    } catch {} // tolerate a torn/partial line
  }
  return parsed;
}

/** For tests: absolute path of the audit file so suites can clean up. */
export function _auditFileForTests() {
  return auditFile;
}
