// The 3D scene camera as a gameplay tool. The eye orbits 4 fixed corners of
// the well; stepping a corner is a deliberate act (gravity pauses during the
// swing — see isInMotion). Layered on top, a continuous parallax "peek" (head
// crane / lean within the dead band) tilts the view a few degrees to reveal
// occlusion WITHOUT changing state. Trauma shake + idle wobble compose last,
// after lookAt, so they jitter the frame without re-aiming.

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

  // Scratch (no per-frame allocation).
  private readonly rel = new Vector3();
  private readonly right = new Vector3();

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(CAMERA_FOV, aspect, 0.1, 400);
    this.cornerPosition(0, this.target);
    this.baseEye.copy(this.target);
    this.camera.position.copy(this.target);
    this.camera.lookAt(this.center);
  }

  private cornerPosition(i: number, out: Vector3): Vector3 {
    // Quadrants: 0:+x+z  1:-x+z  2:-x-z  3:+x-z (matches Well.setCorner).
    const angle = (i * 90 + 45) * (Math.PI / 180);
    out.set(
      WELL_CENTER_X + Math.cos(angle) * CAMERA_RADIUS,
      CAMERA_HEIGHT,
      WELL_CENTER_Z + Math.sin(angle) * CAMERA_RADIUS,
    );
    return out;
  }

  /** Step to the next/previous corner. dir > 0 = right, < 0 = left. */
  orbit(dir: number, nowMs: number): number {
    this.corner = (((this.corner + (dir > 0 ? 1 : -1)) % 4) + 4) % 4;
    this.cornerPosition(this.corner, this.target);
    this.inMotionUntil = nowMs + ORBIT_PAUSE_MS;
    return this.corner;
  }

  /** True while the camera is swinging to a new corner (gravity pauses). */
  isInMotion(nowMs: number): boolean {
    return nowMs < this.inMotionUntil;
  }

  addTrauma(amount: number): void {
    this.trauma.add(amount);
  }

  resetTrauma(): void {
    this.trauma.reset();
  }

  update(dt: number, nowMs: number): void {
    // 1. ease the base eye toward the active corner.
    this.baseEye.lerp(this.target, frameLerp(CAMERA_LERP_PER_FRAME, dt));

    // 2. automatic peek-sway: a slow orbit-drift around the corner so the back
    // of the stack is always glimpsed. Never touches the logical corner, so the
    // camera-relative controls stay stable.
    const tp = (nowMs / AUTO_PEEK_PERIOD_MS) * Math.PI * 2;
    this.peekYawTarget = Math.sin(tp) * PEEK_YAW_MAX;
    this.peekPitchTarget = Math.sin(tp * 0.6 + 1.3) * PEEK_PITCH_MAX;
    const y = smoothDamp(this.peekYaw, this.peekYawTarget, this.peekYawVel, PEEK_OMEGA, dt);
    this.peekYaw = y.pos;
    this.peekYawVel = y.vel;
    const p = smoothDamp(this.peekPitch, this.peekPitchTarget, this.peekPitchVel, PEEK_OMEGA, dt);
    this.peekPitch = p.pos;
    this.peekPitchVel = p.vel;

    // 3. orbit the eye around the centre by the peek angles.
    this.rel.copy(this.baseEye).sub(this.center);
    this.rel.applyAxisAngle(UP, this.peekYaw);
    this.right.crossVectors(UP, this.rel).normalize();
    this.rel.applyAxisAngle(this.right, this.peekPitch);
    this.camera.position.copy(this.center).add(this.rel);

    // 4. idle breathing wobble.
    const t = nowMs / 2000;
    this.camera.position.x += (Math.sin(t) * CAMERA_WOBBLE) / 2;
    this.camera.position.y += (Math.cos(t * 1.3) * CAMERA_WOBBLE) / 2;

    this.camera.up.copy(UP);
    this.camera.lookAt(this.center);

    // 5. trauma shake AFTER lookAt so it jitters without re-aiming.
    const shake = this.trauma.update(dt, nowMs / 1000);
    if (shake.ox !== 0 || shake.oy !== 0 || shake.rot !== 0) {
      this.camera.translateX(shake.ox);
      this.camera.translateY(shake.oy);
      this.camera.rotateZ(shake.rot);
    }
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
