// FSM state: standing still. Entering it picks the idle animation, which
// the client sends to the server so every player sees it.
export default class IdleState {
  enter(player) {
    player.animName = 'idle';
  }

  update(player, fsm) {
    if (player.moving) fsm.transition('Run', player);
  }
}
