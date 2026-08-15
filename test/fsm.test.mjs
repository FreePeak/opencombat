// Unit test for the FSM — plain node:assert, no framework, no three.js.
// Run: npm test
import assert from 'node:assert/strict';
import StateMachine from '../src/fsm/StateMachine.js';
import IdleState from '../src/fsm/states/IdleState.js';
import RunState from '../src/fsm/states/RunState.js';

// Minimal player stub: the states only touch these members.
function makePlayer() {
  return { moving: false, animName: 'idle' };
}

// --- lifecycle ------------------------------------------------------
const calls = [];
const recording = {
  enter(owner) { calls.push(`enter:${owner}`); },
  update(owner) { calls.push(`update:${owner}`); },
  exit(owner) { calls.push(`exit:${owner}`); }
};
const fsm = new StateMachine('A');
fsm.addState('A', recording);
fsm.addState('B', recording);
fsm.start('owner');
assert.deepEqual(calls, ['enter:owner'], 'start() fires enter on the initial state');

fsm.transition('B', 'owner');
assert.deepEqual(calls, ['enter:owner', 'exit:owner', 'enter:owner'], 'transition exits A then enters B');

fsm.update('owner', 16);
assert.deepEqual(calls.slice(-1), ['update:owner'], 'update forwards to the active state');

fsm.transition('B', 'owner'); // same state
assert.equal(fsm.current, 'B', 'same-state transition is a no-op');

fsm.transition('Nope', 'owner'); // unknown state
assert.equal(fsm.current, 'B', 'unknown-state transition is a no-op');

// --- Idle/Run integration ------------------------------------------
const player = makePlayer();
const pm = new StateMachine('Idle');
pm.addState('Idle', new IdleState());
pm.addState('Run', new RunState());
pm.start(player);

assert.equal(pm.current, 'Idle', 'player starts Idle');
assert.equal(player.animName, 'idle', 'IdleState.enter picks the idle anim');
pm.update(player, 16);
assert.equal(pm.current, 'Idle', 'no input keeps Idle');

player.moving = true;
pm.update(player, 16); // Idle detects input, fires Idle -> Run
assert.equal(pm.current, 'Run', 'input moves Idle -> Run');
assert.equal(player.animName, 'run', 'RunState.enter picks the run anim');

pm.update(player, 16); // still Run while moving
assert.equal(pm.current, 'Run', 'still Run while moving');
assert.equal(player.animName, 'run', 'anim stays run');

player.moving = false;
pm.update(player, 16);
assert.equal(pm.current, 'Idle', 'no input returns to Idle');
assert.equal(player.animName, 'idle', 'IdleState.enter sets idle again');

console.log('ok — fsm.test.mjs: all assertions passed');
