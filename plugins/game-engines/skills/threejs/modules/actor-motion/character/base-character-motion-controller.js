import { Vector3 } from "three";
import { clamp, smoothingAlpha, smoothToward } from "../../math/scalar-utils.js";
import { toVec3, VECTOR_EPS } from "../../math/vector3-utils.js";
import { DEFAULT_WORLD_BASIS } from "../../math/world-basis.js";

const EPS_SQ = VECTOR_EPS * VECTOR_EPS;

export class BaseCharacterMotionController {
  constructor({
    walkSpeed = 6,
    sprintSpeed = 9,
    crouchSpeed = 3.2,
    accelerationLag = 0.04,
    decelerationLag = 0.05,
    airAccelerationLag = 0.11,
    turnLag = 0,
    gravity = 9.81,
    jumpVelocity = 8.5,
    maxFallSpeed = 55,
    pitchMin = -1.45,
    pitchMax = 1.45,
    basis = DEFAULT_WORLD_BASIS,
  }) {
    this.cfg = {
      walkSpeed,
      sprintSpeed,
      crouchSpeed,
      accelerationLag,
      decelerationLag,
      airAccelerationLag,
      turnLag,
      gravity,
      jumpVelocity,
      maxFallSpeed,
      pitchMin,
      pitchMax,
    };

    this.basis = basis;
    this.position = new Vector3();
    this.velocity = new Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = true;
  }

  setState(options = {}) {
    if (options.position) this.position.copy(toVec3(options.position));
    if (options.velocity) this.velocity.copy(toVec3(options.velocity));
    if (options.grounded !== undefined) this.grounded = options.grounded;
    if (options.forward) {
      const forward = this._planarUnit(toVec3(options.forward));
      this.yaw = this.basis.forwardToYaw(forward);
    }
    if (options.yaw !== undefined) this.yaw = options.yaw;
    if (options.pitch !== undefined)
      this.pitch = clamp(options.pitch, this.cfg.pitchMin, this.cfg.pitchMax);
  }

  snapshot() {
    return this._stateOutput();
  }

  commitMovement(intent, resolved = null) {
    const position = toVec3(resolved ? resolved.position : intent.position);
    const velocity = toVec3(resolved ? resolved.velocity : intent.velocity);
    const correctedDelta = toVec3(resolved ? resolved.correctedDelta : intent.desiredDelta);
    let grounded = resolved ? resolved.grounded : intent.grounded;

    // Cancel upward velocity when collision clipped the requested upward move.
    if (
      this.basis.upComponent(intent.desiredDelta) > this.basis.upComponent(correctedDelta) + 1e-5 &&
      this.basis.upComponent(velocity) > 0
    ) {
      this.basis.flatten(velocity);
    }
    // Keep the character airborne while jump velocity is still rising.
    if (intent.grounded === false && this.basis.upComponent(intent.velocity) > 0) grounded = false;
    // Remove downward velocity after landing so the character does not sink.
    if (grounded && this.basis.upComponent(velocity) < 0) this.basis.flatten(velocity);

    this.position.copy(position);
    this.velocity.copy(velocity);
    this.grounded = grounded;
    this.yaw = intent.yaw;
    this.pitch = clamp(intent.pitch, this.cfg.pitchMin, this.cfg.pitchMax);

    return this._stateOutput();
  }

  _prepareLocomotion({
    moveDirection,
    facingDirection = null,
    sprint,
    crouch,
    jump,
    yaw = this.yaw,
    pitch = this.pitch,
    deltaSeconds,
  }) {
    const startPosition = this.position.clone();
    const moveDir = this._planarUnit(moveDirection);
    const targetSpeed = crouch
      ? this.cfg.crouchSpeed
      : sprint
        ? this.cfg.sprintSpeed
        : this.cfg.walkSpeed;
    const targetVelocity = moveDir.clone().multiplyScalar(targetSpeed);
    const hasMoveInput = moveDir.lengthSq() > EPS_SQ;
    const nextVelocity = this.velocity.clone();
    let nextGrounded = this.grounded;

    const accelLag = hasMoveInput
      ? nextGrounded
        ? this.cfg.accelerationLag
        : this.cfg.airAccelerationLag
      : this.cfg.decelerationLag;

    for (const axis of [this.basis.rightAxis.axis, this.basis.forwardAxis.axis]) {
      nextVelocity[axis] = smoothToward(
        nextVelocity[axis],
        targetVelocity[axis],
        accelLag,
        deltaSeconds,
      );
    }

    if (nextGrounded) {
      this.basis.flatten(nextVelocity);
      if (jump && !crouch) {
        this.basis.setHeight(nextVelocity, this.cfg.jumpVelocity);
        nextGrounded = false;
      }
    }

    if (!nextGrounded) {
      this.basis.setHeight(
        nextVelocity,
        Math.max(
          this.basis.upComponent(nextVelocity) - this.cfg.gravity * deltaSeconds,
          -this.cfg.maxFallSpeed,
        ),
      );
    }

    let nextYaw = yaw;
    const facingDir = facingDirection ? this._planarUnit(facingDirection) : null;
    if (facingDir && facingDir.lengthSq() > EPS_SQ) {
      const targetYaw = this.basis.forwardToYaw(facingDir);
      const yawDelta = Math.atan2(Math.sin(targetYaw - nextYaw), Math.cos(targetYaw - nextYaw));
      nextYaw += yawDelta * smoothingAlpha(this.cfg.turnLag, deltaSeconds);
    }

    const nextPitch = clamp(pitch, this.cfg.pitchMin, this.cfg.pitchMax);
    const desiredDelta = nextVelocity.clone().multiplyScalar(deltaSeconds);
    const position = startPosition.clone().add(desiredDelta);

    return {
      position,
      startPosition,
      desiredDelta,
      deltaSeconds,
      velocity: nextVelocity.clone(),
      grounded: nextGrounded,
      yaw: nextYaw,
      pitch: nextPitch,
    };
  }

  _planarUnit(value) {
    const vector = value.clone();
    this.basis.flatten(vector);
    const lengthSq = vector.lengthSq();
    return lengthSq > EPS_SQ ? vector.multiplyScalar(1 / Math.sqrt(lengthSq)) : new Vector3();
  }

  _directionTo(target, from = this.position) {
    return this._planarUnit(target.clone().sub(from));
  }

  _stateOutput() {
    const viewFrame = this.basis.yawPitchRollFrame(this.yaw, this.pitch);
    const planarMoveFrame = this.basis.yawPitchRollFrame(this.yaw);
    return {
      position: this.position.clone(),
      velocity: this.velocity.clone(),
      grounded: this.grounded,
      yaw: this.yaw,
      pitch: this.pitch,
      viewFrame: {
        forward: viewFrame.forward,
        right: viewFrame.right,
        up: viewFrame.up,
      },
      planarMoveFrame: {
        forward: planarMoveFrame.forward,
        right: planarMoveFrame.right,
        up: this.basis.upVector(),
      },
    };
  }
}
