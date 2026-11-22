import { PerspectiveCamera, Vector3 } from "three";

import {
  AUTO_PEEK_PERIOD_MS,
  CAMERA_FOV,
  CAMERA_HEIGHT,
  CAMERA_LERP_PER_FRAME,
  CAMERA_RADIUS,
  CAMERA_WOBBLE,
  ORBIT_PAUSE_MS,
  PEEK_OMEGA,
  PEEK_PITCH_MAX,
  PEEK_YAW_MAX,
  WELL_CENTER_X,
  WELL_CENTER_Z,
  WELL_HEIGHT,
} from "../shared/constants";
import { frameLerp, smoothDamp } from "../shared/math";
import { TraumaCamera } from "./trauma-camera";

const UP = new Vector3(0, 1, 0);

export class CameraRig {
  readonly camera: PerspectiveCamera;
  corner = 0;

  private readonly center = new Vector3(WELL_CENTER_X, WELL_HEIGHT * 0.32, WELL_CENTER_Z);
  private readonly baseEye = new Vector3();
  private readonly target = new Vector3();
  private inMotionUntil = 0;

  private peekYaw = 0;
  private peekPitch = 0;
  private peekYawVel = 0;
  private peekPitchVel = 0;
  private peekYawTarget = 0;
  private peekPitchTarget = 0;

  private readonly trauma = new TraumaCamera();
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  private readonly rel = new Vector3();
  private readonly right = new Vector3();

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(CAMERA_FOV, aspect, 1, 400);
    this.resize(aspect);
    CameraRig.cornerPosition(0, this.target);
    this.baseEye.copy(this.target);
    this.camera.position.copy(this.target);
    this.camera.lookAt(this.center);
  }

  private static cornerPosition(i: number, out: Vector3) {
    const angle = (i * 90 + 45) * (Math.PI / 180);
    out.set(
      WELL_CENTER_X + Math.cos(angle) * CAMERA_RADIUS,
      CAMERA_HEIGHT,
      WELL_CENTER_Z + Math.sin(angle) * CAMERA_RADIUS,
    );

    return out;
  }

  /** Step to the next/previous corner. dir > 0 = right, < 0 = left. */
  orbit(dir: number, nowMs: number) {
    this.corner = (((this.corner + (dir > 0 ? 1 : -1)) % 4) + 4) % 4;
    CameraRig.cornerPosition(this.corner, this.target);
    this.inMotionUntil = nowMs + ORBIT_PAUSE_MS;

    return this.corner;
  }

  /** True while the camera is swinging to a new corner (gravity pauses). */
  isInMotion(nowMs: number) {
    return nowMs < this.inMotionUntil;
  }

  shiftWallClock(pausedMs: number) {
    this.inMotionUntil += pausedMs;
  }

  addTrauma(amount: number) {
    this.trauma.add(amount);
  }

  resetTrauma() {
    this.trauma.reset();
  }

  update(dt: number, nowMs: number) {
    const reduced = this.reducedMotion.matches;
    this.baseEye.lerp(this.target, frameLerp(CAMERA_LERP_PER_FRAME, dt));

    const tp = (nowMs / AUTO_PEEK_PERIOD_MS) * Math.PI * 2;
    this.peekYawTarget = reduced ? 0 : Math.sin(tp) * PEEK_YAW_MAX;
    this.peekPitchTarget = reduced ? 0 : Math.sin(tp * 0.6 + 1.3) * PEEK_PITCH_MAX;
    const y = smoothDamp(this.peekYaw, this.peekYawTarget, this.peekYawVel, PEEK_OMEGA, dt);
    this.peekYaw = y.pos;
    this.peekYawVel = y.vel;
    const p = smoothDamp(this.peekPitch, this.peekPitchTarget, this.peekPitchVel, PEEK_OMEGA, dt);
    this.peekPitch = p.pos;
    this.peekPitchVel = p.vel;

    this.rel.copy(this.baseEye).sub(this.center);
    this.rel.applyAxisAngle(UP, this.peekYaw);
    this.right.crossVectors(UP, this.rel).normalize();
    this.rel.applyAxisAngle(this.right, this.peekPitch);
    this.camera.position.copy(this.center).add(this.rel);

    const t = nowMs / 2000;

    if (!reduced) {
      this.camera.position.x += (Math.sin(t) * CAMERA_WOBBLE) / 2;
      this.camera.position.y += (Math.cos(t * 1.3) * CAMERA_WOBBLE) / 2;
    }

    this.camera.up.copy(UP);
    this.camera.lookAt(this.center);

    const shake = this.trauma.update(dt, nowMs / 1000);

    if (!reduced && (shake.ox !== 0 || shake.oy !== 0 || shake.rot !== 0)) {
      this.camera.translateX(shake.ox);
      this.camera.translateY(shake.oy);
      this.camera.rotateZ(shake.rot);
    }
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.fov =
      aspect >= 1
        ? CAMERA_FOV
        : Math.min(
            110,
            (Math.atan(Math.tan((CAMERA_FOV * Math.PI) / 360) / aspect) * 360) / Math.PI,
          );
    this.camera.updateProjectionMatrix();
  }
}
