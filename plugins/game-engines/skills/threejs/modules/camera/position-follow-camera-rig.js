import { BaseCameraRig, CAMERA_ROTATION_MODES } from "./base-camera-rig.js";
import { toVec3 } from "../math/vector3-utils.js";
import { DEFAULT_WORLD_BASIS } from "../math/world-basis.js";

export class PositionFollowCameraRig extends BaseCameraRig {
  constructor({
    azimuth = 0,
    distance = 18,
    height = 16,
    lookHeight = 0,
    positionLag = 0.0,
    lookLag = 0.0,
    basis = DEFAULT_WORLD_BASIS,
  }) {
    super({ basis, rotationMode: CAMERA_ROTATION_MODES.lookAt });
    Object.assign(this, {
      azimuth,
      distance,
      height,
      lookHeight,
      positionLag,
      lookLag,
    });
  }

  step({ targetPosition, snapToTarget = false, deltaSeconds = 1 / 60, camera = null }) {
    const focus = toVec3(targetPosition);

    const viewDirection = this.basis
      .fromBasisComponents(Math.sin(this.azimuth), 0, Math.cos(this.azimuth))
      .normalize();
    const cameraPosition = focus.clone().addScaledVector(viewDirection, -this.distance);
    const cameraLookAt = focus.clone();
    const baseHeight = this.basis.upComponent(focus);

    this.basis.setHeight(cameraPosition, baseHeight + this.height);
    this.basis.setHeight(cameraLookAt, baseHeight + this.lookHeight);
    this.smoothVector(this.position, cameraPosition, this.positionLag, deltaSeconds, snapToTarget);
    this.smoothVector(this.lookAt, cameraLookAt, this.lookLag, deltaSeconds, snapToTarget);

    this.setLookAtPose({
      position: this.position,
      lookAt: this.lookAt,
      up: this.basis.upVector(),
    });

    const pose = this.getPose();
    this.applyToCamera(camera, pose);
    return pose;
  }
}
