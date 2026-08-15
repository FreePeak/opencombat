// FSM state: moving. Entering it picks the run animation.
export default class RunState {
  enter(player) {
    player.animName = 'run';
  }

  update(player, fsm) {
    if (!player.moving) fsm.transition('Idle', player);
  }
}
