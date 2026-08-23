// Damage direction indicator (FR-HUD-04): pure screen-angle evaluator plus
// both-room 'damaged' message emission so the client can point a wedge at
// the hit source.
// Run: node --test test/damageDir.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dirAngleDeg } from '../src/shared/sim/damageDir.js';
import { LocalRoom } from '../src/LocalRoom.js';
import { SERVER } from '../src/server/config.js';

test('cardinals: up(-z)=0, east(+x)=90, south(+z)=180, west(-x)=270', () => {
  // angle measured clockwise from screen-up (world -z), CSS-rotation ready
  assert.equal(dirAngleDeg(0, -1, 0, 0), 0); // source ahead/north of player
  assert.equal(dirAngleDeg(1, 0, 0, 0), 90);
  assert.equal(dirAngleDeg(0, 1, 0, 0), 180);
  assert.equal(dirAngleDeg(-1, 0, 0, 0), 270);
});

test('range [0,360) and determinism', () => {
  for (let i = 0; i < 24; i++) {
    const a = dirAngleDeg(Math.cos(i), Math.sin(i * 2), 3, -4);
    assert.ok(a >= 0 && a < 360, `angle in range (${a})`);
    assert.equal(a, dirAngleDeg(Math.cos(i), Math.sin(i * 2), 3, -4));
  }
});

test('degenerate: source == player position -> 0, no NaN', () => {
  assert.equal(dirAngleDeg(5, 5, 5, 5), 0);
});

test('LOCAL room emits damaged {x,z} on successful hit only', async () => {
  const room = new LocalRoom({});
  try {
    const seen = [];
    room.onMessage('damaged', (d) => seen.push(d));
    await room.join('DirTest', 0);
    room._running = false;
    room._countdownTimer = 0;
    room._step(0.05);
    const me = room.state.players.get(room.sessionId);
    assert.ok(me, 'local player exists');
    const hpBefore = me.hp;
    const ok = room._damagePlayer(me, 10, { x: me.x + 3, z: me.z - 2 });
    assert.equal(ok, true);
    assert.equal(seen.length, 1, 'exactly one damaged message');
    assert.equal(seen[0].x, me.x + 3);
    assert.equal(seen[0].z, me.z - 2);
    assert.ok(me.hp < hpBefore);
    // blocked/shield hits emit nothing
    seen.length = 0;
    me.effects.set('shield', 5000);
    const blocked = room._damagePlayer(me, 10, { x: me.x + 1, z: me.z });
    assert.equal(blocked, false);
    assert.equal(seen.length, 0, 'no damaged message when shield absorbs');
  } finally {
    try { room.leave(); } catch {}
  }
});
