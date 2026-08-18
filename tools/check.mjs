// Syntax-check every source/test file (node --check) via one glob instead of
// the hardcoded && chain that used to live in package.json. New files under
// src/ or test/ are picked up automatically — nothing to maintain.
// Run: npm run check
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** Recursively collect .js/.mjs files under dir. */
function walk(dir, acc = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === 'node_modules') continue;
      walk(p, acc);
    } else if (/\.m?js$/.test(name.name)) {
      acc.push(p);
    }
  }
  return acc;
}

const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'test'))].sort();
let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`ok — ${file}`);
  } catch (err) {
    failed++;
    console.error(`FAIL — ${file}`);
    console.error(err.stderr?.toString() || err.message);
  }
}
if (failed) {
  console.error(`\n${failed}/${files.length} file(s) failed syntax check`);
  process.exit(1);
}
console.log(`\n${files.length} file(s) passed syntax check`);
