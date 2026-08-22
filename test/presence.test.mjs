import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPresence, updateMode, removePresence,
  listPresence, presenceCount, _resetForTests
} from '../src/server/presence.js';

test('register + list: shape, sort order, count', () => {
  _resetForTests();
  registerPresence('s1', { name: 'Alpha', mode: 'waves', roomId: 'r1' });
  registerPresence('s2', { name: 'Beta', mode: 'world' });
  assert.equal(presenceCount(), 2);
  const list = listPresence();
  assert.deepEqual(list.map(p => p.name), ['Alpha', 'Beta'], 'oldest first');
  assert.equal(list[0].mode, 'waves');
  assert.equal(list[0].roomId, 'r1');
  assert.equal(list[1].roomId, null);
});

test('re-register same sid upserts without dupes', () => {
  _resetForTests();
  registerPresence('s1', { name: 'Alpha', mode: 'waves' });
  registerPresence('s1', { name: 'Alpha', mode: 'arena' });
  assert.equal(presenceCount(), 1);
  assert.equal(listPresence()[0].mode, 'arena');
});

test('updateMode mutates in place, missing sid no-ops', () => {
  _resetForTests();
  registerPresence('s1', { name: 'A', mode: 'lobby' });
  assert.equal(updateMode('s1', 'world').mode, 'world');
  assert.equal(listPresence()[0].mode, 'world');
  assert.equal(updateMode('ghost', 'world'), null);
});

test('removePresence deletes; falsy sid rejected at register', () => {
  _resetForTests();
  registerPresence('s1', { name: 'A' });
  assert.equal(removePresence('s1'), true);
  assert.equal(removePresence('s1'), false);
  assert.equal(presenceCount(), 0);
  assert.equal(registerPresence('', { name: 'X' }), null);
  assert.equal(registerPresence(null, { name: 'X' }), null);
});

test('missing fields get safe defaults', () => {
  _resetForTests();
  registerPresence('s9');
  const [p] = listPresence();
  assert.equal(p.name, 'anon');
  assert.equal(p.mode, 'idle');
});
