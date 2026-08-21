// 'direct' source: pinned CDN URLs captured from poly.pizza model pages
// (static.poly.pizza serves GLBs keylessly). See docs/artwork-ui-rework/RESEARCH.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSourceUrl } from '../src/tools/assetPipeline.js';

test('resolveSourceUrl passes pinned direct CDN urls through', () => {
  const url = resolveSourceUrl(
    { source: 'direct', url: 'https://static.poly.pizza/99357ca2-6364-4990-8d4c-9bc5a1a5e859.glb.br' },
    {}
  );
  assert.equal(url, 'https://static.poly.pizza/99357ca2-6364-4990-8d4c-9bc5a1a5e859.glb.br');
});

test('resolveSourceUrl direct without url resolves to null', () => {
  assert.equal(resolveSourceUrl({ source: 'direct' }, {}), null);
});
