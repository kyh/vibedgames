import { Vector3 } from "three";
import { BaseCharacterMotionController } from "./base-character-motion-controller.js";

export class HeadingRelativeCharacterMotionController extends BaseCharacterMotionController {
  constructor({ turnRate = 2.8, ...config }) {
    super(config);
    this.cfg.turnRate = turnRate;
  }

  // forward/backward: 0..1 moves along the local forward/backward directions.
  // strafeLeft/strafeRight: 0..1 moves along the local left/right directions.
  // turnLeft/turnRight: 0..1 rotates toward the local left/right directions.
  planMovement({
    forward = 0,
    backward = 0,
    strafeLeft = 0,
    strafeRight = 0,
    turnLeft = 0,
    turnRight = 0,
    sprint = false,
    crouch = false,
    jump = false,
    deltaSeconds = 1 / 60,
    commit = false,
  }) {
    const moveRight =
      this.basis.controlSignal("left", strafeLeft) + this.basis.controlSignal("right", strafeRight);
    const moveForward =
      this.basis.controlSignal("backward", backward) + this.basis.controlSignal("forward", forward);
    const turnInput =
      this.basis.controlSignal("counterClockWise", turnLeft) +
      this.basis.controlSignal("clockWise", turnRight);
    const nextYaw = this.yaw + turnInput * this.cfg.turnRate * deltaSeconds;
    const inputLength = Math.hypot(moveRight, moveForward);
    const inputScale = inputLength > 1 ? 1 / inputLength : 1;
    const moveFrame = this.basis.yawPitchRollFrame(nextYaw);
    const moveDirection =
      inputLength > 0
        ? moveFrame.right
            .multiplyScalar(moveRight * inputScale)
            .addScaledVector(moveFrame.forward, moveForward * inputScale)
        : new Vector3();

    const intent = this._prepareLocomotion({
      moveDirection,
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
