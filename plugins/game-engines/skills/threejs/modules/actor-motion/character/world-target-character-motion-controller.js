import { Vector3 } from "three";
import { BaseCharacterMotionController } from "./base-character-motion-controller.js";

export class WorldTargetCharacterMotionController extends BaseCharacterMotionController {
  constructor({ stopRadius = 0.35, ...config }) {
    super(config);
    this.cfg.stopRadius = stopRadius;
  }

  // moveTarget: move toward a world position.
  // faceTarget: face toward a world position when no move target is active.
  planMovement({
    moveTarget = null,
    faceTarget = null,
    sprint = false,
    crouch = false,
    jump = false,
    deltaSeconds = 1 / 60,
    commit = false,
  }) {
    const activeMoveTarget = moveTarget
      ? new Vector3(moveTarget.x, moveTarget.y, moveTarget.z)
      : null;
    const activeFaceTarget = faceTarget
      ? new Vector3(faceTarget.x, faceTarget.y, faceTarget.z)
      : null;
    const targetDistance = activeMoveTarget
      ? Math.sqrt(this.basis.distanceSqPlanar(activeMoveTarget, this.position))
      : Infinity;
    const targetReached = targetDistance <= this.cfg.stopRadius;

    const moveDirection =
      activeMoveTarget && !targetReached ? this._directionTo(activeMoveTarget) : new Vector3();
    const facingDirection =
      activeMoveTarget && !targetReached
        ? moveDirection
        : activeFaceTarget
          ? this._directionTo(activeFaceTarget)
          : null;

    const intent = this._prepareLocomotion({
      moveDirection,
      facingDirection,
      sprint,
      crouch,
      jump,
      deltaSeconds,
    });

    if (commit) return this.commitMovement(intent);
    return intent;
  }
}
