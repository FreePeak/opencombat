// License guard test — the project ships MIT-licensed code with properly
// attributed CC0/CC-BY assets. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('LICENSE exists at repo root and is the standard MIT text', () => {
  const text = readFileSync(path.join(root, 'LICENSE'), 'utf8');
  assert.match(text, /MIT License/, 'LICENSE must contain "MIT License"');
  assert.match(text, /Permission is hereby granted/, 'LICENSE must contain "Permission is hereby granted"');
});

test('package.json declares license "MIT"', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT');
});

test('README has a License section mentioning MIT', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const section = readme.split(/^## /m).find((s) => s.startsWith('License'));
  assert.ok(section, 'README must contain a "## License" section');
  assert.match(section, /\bMIT\b/, 'License section must mention MIT');
});
