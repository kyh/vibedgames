import { BaseCameraRig, CAMERA_HEIGHT_SOURCES, CAMERA_ROTATION_MODES } from "./base-camera-rig.js";
import { toVec3 } from "../math/vector3-utils.js";
import { DEFAULT_WORLD_BASIS } from "../math/world-basis.js";

export class FirstPersonCameraRig extends BaseCameraRig {
  constructor({
    eyeHeight = 1.72,
    lookDistance = 1,
    heightVectorSource = CAMERA_HEIGHT_SOURCES.frameUp,
    basis = DEFAULT_WORLD_BASIS,
  }) {
    super({ basis, rotationMode: CAMERA_ROTATION_MODES.lookAt });
    this.eyeHeight = eyeHeight;
    this.lookDistance = lookDistance;
    this.heightVectorSource = heightVectorSource;
  }

  step({ targetPosition, targetFrame, camera = null }) {
    const frame = this.resolveTargetFrame(targetFrame);
    const heightVector = this.vectorFromSource(this.heightVectorSource, frame);
    const position = toVec3(targetPosition).addScaledVector(heightVector, this.eyeHeight);

    this.setLookAtPose({
      position,
      lookAt: position.clone().addScaledVector(frame.forward, this.lookDistance),
      up: frame.up,
    });

    const pose = this.getPose();
    this.applyToCamera(camera, pose);
    return pose;
  }
}
