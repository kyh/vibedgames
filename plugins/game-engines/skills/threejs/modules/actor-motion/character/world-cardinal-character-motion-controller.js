import { Vector3 } from "three";
import { BaseCharacterMotionController } from "./base-character-motion-controller.js";

export class WorldCardinalCharacterMotionController extends BaseCharacterMotionController {
  constructor({ turnRate = 2.8, ...config }) {
    super(config);
    this.cfg.turnRate = turnRate;
  }

  // forward/backward: 0..1 moves along the basis forward/backward directions.
  // left/right: 0..1 moves along the basis left/right directions.
  // rotateCCW/rotateCW: 0..1 rotates toward the basis counter-clockwise/clockwise directions.
  planMovement({
    forward = 0,
    backward = 0,
    left = 0,
    right = 0,
    rotateCCW = 0,
    rotateCW = 0,
    sprint = false,
    crouch = false,
    jump = false,
    deltaSeconds = 1 / 60,
    commit = false,
  }) {
    const moveRight =
      this.basis.controlSignal("left", left) + this.basis.controlSignal("right", right);
    const moveForward =
      this.basis.controlSignal("backward", backward) + this.basis.controlSignal("forward", forward);
    const turnAxis =
      this.basis.controlSignal("counterClockWise", rotateCCW) +
      this.basis.controlSignal("clockWise", rotateCW);
    const nextYaw = this.yaw + turnAxis * this.cfg.turnRate * deltaSeconds;
    const moveDirection =
      Math.hypot(moveRight, moveForward) > 0
        ? this._planarUnit(this.basis.fromBasisComponents(moveRight, 0, moveForward))
        : new Vector3();

    const intent = this._prepareLocomotion({
      moveDirection,
      facingDirection: turnAxis === 0 && moveDirection.lengthSq() > 0 ? moveDirection : null,
      sprint,
      crouch,
      jump,
      yaw: nextYaw,
      deltaSeconds,
    });

    if (commit) return this.commitMovement(intent);
    return intent;
  }
}
