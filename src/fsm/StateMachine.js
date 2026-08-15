// Tiny generic Finite State Machine (no three.js imports — runs in Node
// for tests). Same API as termgame's.
//
// A state is any object with optional lifecycle methods:
//   enter(owner, fsm)    — called once when the state becomes active
//   update(owner, fsm, dt) — called every frame while active
//   exit(owner, fsm)     — called once when the state is left
export default class StateMachine {
  constructor(initialState) {
    this.states = new Map();
    this.current = initialState; // name of the active state
    this.currentState = null;    // active state object
  }

  /** Register a state under `name`. */
  addState(name, state) {
    this.states.set(name, state);
    return this;
  }

  /**
   * Activate the initial state. Call once after all states are registered.
   * Unlike transition(), this fires enter() even though `current` already
   * holds the initial state's name.
   */
  start(owner) {
    this.currentState = this.states.get(this.current);
    if (this.currentState?.enter) this.currentState.enter(owner, this);
  }

  /** Switch to `name`. No-op if the state is unknown or already active. */
  transition(name, owner) {
    if (name === this.current || !this.states.has(name)) return;
    if (this.currentState?.exit) this.currentState.exit(owner, this);
    this.current = name;
    this.currentState = this.states.get(name);
    if (this.currentState?.enter) this.currentState.enter(owner, this);
  }

  /** Per-frame tick; forwards to the active state. */
  update(owner, dt) {
    if (this.currentState?.update) this.currentState.update(owner, this, dt);
  }
}
