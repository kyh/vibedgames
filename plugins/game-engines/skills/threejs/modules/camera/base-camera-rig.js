import { Matrix4, Vector3 } from "three";
import { smoothingAlpha } from "../math/scalar-utils.js";
import { toUnitVec3, toVec3 } from "../math/vector3-utils.js";
import { DEFAULT_WORLD_BASIS } from "../math/world-basis.js";

const EPS = 1e-12;

export const CAMERA_ROTATION_MODES = Object.freeze({
  lookAt: "lookAt",
  frame: "frame",
});

export const CAMERA_HEIGHT_SOURCES = Object.freeze({
  frameUp: "frameUp",
  basisUp: "basisUp",
});

export class BaseCameraRig {
  constructor({ rotationMode = CAMERA_ROTATION_MODES.lookAt, basis = DEFAULT_WORLD_BASIS }) {
    this.basis = basis;
    this.rotationMode = rotationMode;
    this.position = new Vector3();
    this.lookAt = this.basis.forwardVector();
    this.forward = this.basis.forwardVector();
    this.right = this.basis.rightVector();
    this.up = this.basis.upVector();
    this.initialized = false;
  }

  setState({
    position = null,
    lookAt = null,
    forward = null,
    right = null,
    up = null,
    rotationMode = this.rotationMode,
  }) {
    if (position) this.position.copy(toVec3(position, this.position));
    if (lookAt) this.lookAt.copy(toVec3(lookAt, this.lookAt));
    if (forward) this.forward.copy(toUnitVec3(forward, this.forward));
    if (right) this.right.copy(toUnitVec3(right, this.right));
    if (up) this.up.copy(toUnitVec3(up, this.up));
    this.rotationMode = rotationMode;
    this.initialized = true;
    return this;
  }

  getPose() {
    return {
      position: this.position.clone(),
      lookAt: this.lookAt.clone(),
      forward: this.forward.clone(),
      right: this.right.clone(),
      up: this.up.clone(),
    };
  }

  applyToCamera(camera, pose = this.getPose()) {
    if (!camera) return;

    camera.position.copy(pose.position);
    camera.up.copy(pose.up);

    if (this.rotationMode === CAMERA_ROTATION_MODES.frame) {
      const matrix = new Matrix4().makeBasis(pose.right, pose.up, pose.forward.clone().negate());
      camera.quaternion.setFromRotationMatrix(matrix);
    } else {
      camera.lookAt(pose.lookAt);
    }
  }

  resolveTargetFrame(targetFrame) {
    const forward = toUnitVec3(targetFrame.forward, this.basis.forwardVector());
    const up = toUnitVec3(targetFrame.up, this.basis.upVector());
    const fallbackRight = new Vector3().crossVectors(forward, up);
    if (fallbackRight.lengthSq() <= EPS) fallbackRight.copy(this.basis.rightVector());
    const right = toUnitVec3(targetFrame.right, fallbackRight);
    return { forward, right, up, back: forward.clone().negate() };
  }

  vectorFromSource(source, frame) {
    return source === CAMERA_HEIGHT_SOURCES.basisUp ? this.basis.upVector() : frame.up.clone();
  }

  smoothVector(current, target, lag, deltaSeconds, snapToTarget = false) {
    if (snapToTarget || !this.initialized || lag <= 0) {
      current.copy(target);
      return current;
    }
    return current.lerp(target, smoothingAlpha(lag, deltaSeconds));
  }

  setLookAtPose({ position, lookAt, up }) {
    this.position.copy(position);
    this.lookAt.copy(lookAt);
    this.up.copy(toUnitVec3(up, this.basis.upVector()));
    this.forward.subVectors(this.lookAt, this.position);
    if (this.forward.lengthSq() <= EPS) this.forward.copy(this.basis.forwardVector());
    else this.forward.normalize();
    this.right.crossVectors(this.forward, this.up);
    if (this.right.lengthSq() <= EPS) this.right.copy(this.basis.rightVector());
    else this.right.normalize();
    this.up.crossVectors(this.right, this.forward).normalize();
    this.initialized = true;
  }

  setFramePose({ position, forward, right = null, up }) {
    this.position.copy(position);
    this.forward.copy(toUnitVec3(forward, this.basis.forwardVector()));
    this.up.copy(toUnitVec3(up, this.basis.upVector()));
    this.right.copy(
      right
        ? toUnitVec3(right, this.basis.rightVector())
        : new Vector3().crossVectors(this.forward, this.up),
    );
    if (this.right.lengthSq() <= EPS) this.right.copy(this.basis.rightVector());
    else this.right.normalize();
    this.up.crossVectors(this.right, this.forward).normalize();
    this.lookAt.copy(this.position.clone().add(this.forward));
    this.initialized = true;
  }
}
