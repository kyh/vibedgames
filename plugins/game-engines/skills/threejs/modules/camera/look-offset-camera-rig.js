import { Quaternion } from "three";
import { clamp, smoothingAlpha } from "../math/scalar-utils.js";
import { toVec3 } from "../math/vector3-utils.js";
import { BaseCameraRig } from "./base-camera-rig.js";
import { DEFAULT_WORLD_BASIS } from "../math/world-basis.js";

export class LookOffsetCameraRig extends BaseCameraRig {
  constructor({
    distance = 20,
    lookSensitivity = 0.0035, // 0.2 deg per input unit
    returnLag = 0.17,
    pitchMin = -1.4835, // -85 deg
    pitchMax = 1.4835, // 85 deg
    basis = DEFAULT_WORLD_BASIS,
  }) {
    super({ basis });
    Object.assign(this, {
      distance,
      lookSensitivity,
      returnLag,
      cameraYaw: 0,
      cameraPitch: 0,
      pitchMin,
      pitchMax,
    });
  }

  setSensitivity(value) {
    this.lookSensitivity = value;
    return this;
  }

  setLook(cameraYaw = 0, cameraPitch = 0) {
    this.cameraYaw = cameraYaw;
    this.cameraPitch = clamp(cameraPitch, this.pitchMin, this.pitchMax);
    return this;
  }

  step({
    targetPosition,
    targetYaw = 0,
    targetPitch = 0,
    targetRoll = 0,
    lookActive = false,
    lookDeltaX = 0,
    lookDeltaY = 0,
    deltaSeconds = 1 / 60,
    camera = null,
  }) {
    if (lookActive) {
      this.cameraYaw += lookDeltaX * this.lookSensitivity;
      this.cameraPitch += lookDeltaY * this.lookSensitivity;
      this.cameraPitch = clamp(this.cameraPitch, this.pitchMin, this.pitchMax);
    } else {
      const blend = smoothingAlpha(this.returnLag, deltaSeconds);
      this.cameraYaw += (0 - this.cameraYaw) * blend;
      this.cameraPitch += (0 - this.cameraPitch) * blend;
    }

    const lookAtPosition = toVec3(targetPosition);

    const frame = this.basis.yawPitchRollFrame(
      targetYaw + this.cameraYaw,
      targetPitch + this.cameraPitch,
      targetRoll,
    );
    const cameraPosition = frame.back.clone().multiplyScalar(this.distance).add(lookAtPosition);

    this.setLookAtPose({
      position: cameraPosition,
      lookAt: lookAtPosition,
      up: frame.up,
    });

    const pose = this.getPose();
    this.applyToCamera(camera, pose);
    return pose;
  }
}
