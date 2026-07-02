import { BaseCameraRig, CAMERA_HEIGHT_SOURCES, CAMERA_ROTATION_MODES } from "./base-camera-rig.js";
import { toVec3 } from "../math/vector3-utils.js";
import { DEFAULT_WORLD_BASIS } from "../math/world-basis.js";

export class PoseFollowCameraRig extends BaseCameraRig {
  constructor({
    cameraOffset,
    lookAtOffset = { forward: 1, up: 0, right: 0 },
    speedCameraOffset = { forward: 0, up: 0, right: 0 },
    speedLookAtOffset = { forward: 0, up: 0, right: 0 },
    heightVectorSource = CAMERA_HEIGHT_SOURCES.frameUp,
    lookHeightVectorSource = CAMERA_HEIGHT_SOURCES.frameUp,
    positionLag = 0,
    lookLag = 0,
    frameLag = 0,
    rotationMode = CAMERA_ROTATION_MODES.lookAt,
    basis = DEFAULT_WORLD_BASIS,
  }) {
    super({ basis, rotationMode });
    Object.assign(this, {
      cameraOffset,
      lookAtOffset,
      speedCameraOffset,
      speedLookAtOffset,
      heightVectorSource,
      lookHeightVectorSource,
      positionLag,
      lookLag,
      frameLag,
    });
  }

  step({
    targetPosition,
    targetFrame,
    targetSpeed = 0,
    snapToTarget = false,
    deltaSeconds = 1 / 60,
    camera = null,
  }) {
    const frame = this.resolveTargetFrame(targetFrame);
    const focusPosition = toVec3(targetPosition);
    const speed = Math.max(0, targetSpeed ?? 0);
    const heightVector = this.vectorFromSource(this.heightVectorSource, frame);
    const lookHeightVector = this.vectorFromSource(this.lookHeightVectorSource, frame);

    const cameraOffset = this.offsetForSpeed(this.cameraOffset, this.speedCameraOffset, speed);
    const lookAtOffset = this.offsetForSpeed(this.lookAtOffset, this.speedLookAtOffset, speed);

    const desiredPosition = focusPosition
      .clone()
      .addScaledVector(frame.forward, cameraOffset.forward)
      .addScaledVector(frame.right, cameraOffset.right)
      .addScaledVector(heightVector, cameraOffset.up);
    const desiredLookAt = focusPosition
      .clone()
      .addScaledVector(frame.forward, lookAtOffset.forward)
      .addScaledVector(frame.right, lookAtOffset.right)
      .addScaledVector(lookHeightVector, lookAtOffset.up);

    this.smoothVector(this.position, desiredPosition, this.positionLag, deltaSeconds, snapToTarget);
    this.smoothVector(this.lookAt, desiredLookAt, this.lookLag, deltaSeconds, snapToTarget);

    const desiredForward = frame.forward.clone();
    const desiredUp = frame.up.clone();
    this.smoothVector(
      this.forward,
      desiredForward,
      this.frameLag,
      deltaSeconds,
      snapToTarget,
    ).normalize();
    this.smoothVector(this.up, desiredUp, this.frameLag, deltaSeconds, snapToTarget).normalize();

    if (this.rotationMode === CAMERA_ROTATION_MODES.frame) {
      this.setFramePose({
        position: this.position,
        forward: this.forward,
        up: this.up,
      });
    } else if (this.rotationMode == CAMERA_ROTATION_MODES.lookAt) {
      this.setLookAtPose({
        position: this.position,
        lookAt: this.lookAt,
        up: frame.up,
      });
    }

    const pose = this.getPose();
    this.applyToCamera(camera, pose);
    return pose;
  }

  offsetForSpeed(offset, speedOffset, speed) {
    return {
      forward: offset.forward + speedOffset.forward * speed,
      up: offset.up + speedOffset.up * speed,
      right: offset.right + speedOffset.right * speed,
    };
  }
}
