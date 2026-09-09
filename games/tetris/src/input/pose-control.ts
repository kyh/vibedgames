// Pose → game-intent interpretation for 3D Tetris. Every verb is a body pose;
// the GameScene routes these intents (camera-relative remap, DAS/ARR) and
// mirrors each to a keyboard fallback.
//
// Channels (all can fire in one frame — the reference's "no blocking" property):
//  - STEER:  nose-x vs a calibrated neutral, dead-zoned → screen-left/right.
//  - ORBIT:  circle one RAISED hand → step the camera corner (spin dir = L/R).
//  - ROTATE: turn sideways (shoulders narrow vs the calibrated baseline).
//  - HOLD:   cross your wrists past the opposite shoulders → hold/swap (edge).
//  - POWER:  T-pose (wrists out past the shoulders, shoulder height) → power-sweep
//            (the scene only acts on it when the charge meter is full).
//  - CATCH:  both wrists thrust UP fast → catch-the-collapse (scene gates by state).
//
// Calibration on the first ~24 full-body frames captures the neutral nose-x and
// baseline shoulder width (fixes the legacy frozen-refW drift). recenter() re-runs it.

import type { Keypoint, Pose } from "./camera";
import {
  CATCH_WRIST_VELOCITY,
  CIRCLE_CENTER_LERP,
  CIRCLE_MIN_RADIUS,
  CIRCLE_TRIGGER_RAD,
  HOLD_COOLDOWN_MS,
  NOSE_DEAD_ZONE,
  ORBIT_COOLDOWN_MS,
  POWER_COOLDOWN_MS,
  ROTATE_COOLDOWN_MS,
  TPOSE_WRIST_OUT,
} from "../shared/constants";

/** Game intents a detected pose can drive (wired to GameScene). */
export interface PoseActions {
  /** Held screen-horizontal steer: -1 left, 0 none, +1 right. */
  steer: (dir: -1 | 0 | 1) => void;
  /** Clockwise rotate; returns whether it actually applied (for cooldown). */
  rotate: () => boolean;
  /** Step the scene camera one corner: -1 left, +1 right. */
  orbit: (dir: -1 | 1) => void;
  /** Cross-arms: hold/swap the active piece. */
  hold: () => void;
  /** T-pose: spend a full charge to clear the lowest layer (scene gates). */
  power: () => void;
  /** Throw-hands-up during the collapse (scene ignores it otherwise). */
  catchCollapse: () => void;
}

const CALIB_FRAMES = 24;
const ROTATE_SQUEEZE_FRACTION = 0.58;
const CATCH_COOLDOWN_MS = 500;

interface PoseFrame {
  leftWrist: Keypoint;
  rightWrist: Keypoint;
  nose: Keypoint;
  /** Sign of (right − left) shoulder x; 0 when the shoulders coincide. */
  shoulderSign: number;
  shoulderWidth: number;
  shoulderY: number;
  hipY: number;
  width: number;
  height: number;
  now: number;
}

export class PoseControls {
  readonly actions: PoseActions;

  // calibration
  private calibCount = 0;
  private neutralX = 0.5;
  private baseShoulder = 0;
  private sumNeutralX = 0;
  private sumShoulder = 0;

  // per-channel timers / arming (cooldown stamps start far in the past so the
  // first gesture fires immediately rather than waiting out an absolute time).
  private lastTime = 0;
  private lastOrbitTime = -1e9;
  private lastRotateTime = -1e9;
  private lastCatchTime = -1e9;
  private holdArmed = true;
  private lastHoldTime = -1e9;
  private powerArmed = true;
  private lastPowerTime = -1e9;
  private prevWristY = 0;
  private hasPrev = false;
  // hand-circle orbit detector (EMA centre + accumulated swept angle)
  private centerX = 0;
  private centerY = 0;
  private hasCenter = false;
  private circleAngle = 0;
  private circleAccum = 0;
  private hasCircleAngle = false;

  constructor(actions: PoseActions) {
    this.actions = actions;
  }

  /** Re-run neutral calibration (bound to the recenter key / a settle pose). */
  recenter(): void {
    this.calibCount = 0;
    this.sumNeutralX = 0;
    this.sumShoulder = 0;
    this.hasPrev = false;
  }

  handlePose = (pose: Pose, ctx: CanvasRenderingContext2D | null): void => {
    // overlay guides removed with pose-to-pick; skeleton still drawn by PoseCamera
    void ctx;
    const find = (name: string): Keypoint | undefined =>
      pose.keypoints.find((kp) => kp.name === name);

    const leftWrist = find("left_wrist");
    const rightWrist = find("right_wrist");
    const leftShoulder = find("left_shoulder");
    const rightShoulder = find("right_shoulder");
    const leftHip = find("left_hip");
    const rightHip = find("right_hip");
    const nose = find("nose");

    if (
      !leftWrist ||
      !rightWrist ||
      !leftShoulder ||
      !rightShoulder ||
      !leftHip ||
      !rightHip ||
      !nose
    ) {
      this.hasPrev = false;
      return;
    }

    const now = performance.now();
    const dt = this.hasPrev ? Math.max(0.001, (now - this.lastTime) / 1000) : 0.033;
    const shoulderWidth = Math.abs(rightShoulder.x - leftShoulder.x);
    const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
    const hipY = (leftHip.y + rightHip.y) / 2;
    const W = pose.width || 1;
    const H = pose.height || 1;

    // ---- calibration ---------------------------------------------------------
    if (this.calibCount < CALIB_FRAMES) {
      this.sumNeutralX += 1 - nose.x / W;
      this.sumShoulder += shoulderWidth;
      this.calibCount += 1;
      if (this.calibCount === CALIB_FRAMES) {
        this.neutralX = this.sumNeutralX / CALIB_FRAMES;
        this.baseShoulder = this.sumShoulder / CALIB_FRAMES;
      }
    }

    if (this.calibCount >= CALIB_FRAMES) {
      this.detectGestures({
        height: H,
        hipY,
        leftWrist,
        nose,
        now,
        rightWrist,
        shoulderSign: Math.sign(rightShoulder.x - leftShoulder.x),
        shoulderWidth,
        shoulderY,
        width: W,
      });
    }

    // ---- CATCH / START (both wrists thrust UP fast) --------------------------
    const avgWristY = (leftWrist.y + rightWrist.y) / 2;
    if (this.hasPrev) {
      // +up, normalised/s
      const upVel = (this.prevWristY - avgWristY) / dt / H;
      if (upVel > CATCH_WRIST_VELOCITY && now - this.lastCatchTime > CATCH_COOLDOWN_MS) {
        this.actions.catchCollapse();
        this.lastCatchTime = now;
      }
    }
    this.prevWristY = avgWristY;
    this.hasPrev = true;
    this.lastTime = now;
  };

  /** One calibrated frame's worth of the landmarks every gesture reads. */
  private detectGestures(f: PoseFrame): void {
    // ---- STEER (nose-x vs neutral, dead-zoned) -----------------------------
    const screenX = 1 - f.nose.x / f.width;
    const off = screenX - this.neutralX;
    let dir: -1 | 0 | 1 = 0;
    if (off > NOSE_DEAD_ZONE) {
      dir = 1;
    } else if (off < -NOSE_DEAD_ZONE) {
      dir = -1;
    }
    this.actions.steer(dir);

    // ---- ORBIT (circle one raised hand) ------------------------------------
    this.detectCircleOrbit(f.leftWrist, f.rightWrist, f.shoulderY, f.width, f.height, f.now);
    this.detectRotate(f);
    this.detectHold(f);
    this.detectPower(f);
  }

  /** ROTATE: turn sideways so the shoulders foreshorten. */
  private detectRotate(f: PoseFrame): void {
    if (
      this.baseShoulder > 0 &&
      f.shoulderWidth < ROTATE_SQUEEZE_FRACTION * this.baseShoulder &&
      f.now - this.lastRotateTime > ROTATE_COOLDOWN_MS &&
      this.actions.rotate()
    ) {
      this.lastRotateTime = f.now;
    }
  }

  /** HOLD: crossed wrists at chest height. */
  private detectHold(f: PoseFrame): void {
    const wristSign = Math.sign(f.rightWrist.x - f.leftWrist.x);
    const wristsAtChest =
      f.leftWrist.y > f.shoulderY &&
      f.leftWrist.y < f.hipY &&
      f.rightWrist.y > f.shoulderY &&
      f.rightWrist.y < f.hipY;
    const crossed = f.shoulderSign !== 0 && wristSign === -f.shoulderSign && wristsAtChest;
    if (!crossed) {
      this.holdArmed = true;
    }
    if (this.holdArmed && crossed && f.now - this.lastHoldTime > HOLD_COOLDOWN_MS) {
      this.actions.hold();
      this.holdArmed = false;
      this.lastHoldTime = f.now;
    }
  }

  /** POWER: T-pose — wrists out past the shoulders, at shoulder height. */
  private detectPower(f: PoseFrame): void {
    const out = TPOSE_WRIST_OUT * f.width;
    const wristSpread = Math.abs(f.rightWrist.x - f.leftWrist.x);
    const wristsLevel =
      Math.abs(f.leftWrist.y - f.shoulderY) < f.shoulderWidth * 0.6 &&
      Math.abs(f.rightWrist.y - f.shoulderY) < f.shoulderWidth * 0.6;
    const tpose = wristSpread > f.shoulderWidth + 2 * out && wristsLevel;
    if (!tpose) {
      this.powerArmed = true;
    }
    if (this.powerArmed && tpose && f.now - this.lastPowerTime > POWER_COOLDOWN_MS) {
      this.actions.power();
      this.powerArmed = false;
      this.lastPowerTime = f.now;
    }
  }

  /**
   * Orbit the camera by circling ONE raised hand. Tracks the higher wrist's
   * recent path, estimates its centre, and accumulates the swept angle; once a
   * near-full loop is swept (in a consistent direction) it steps one corner,
   * direction = spin sign. Resets when the hand drops or stops circling, so a
   * still or low hand can never drift the view.
   */
  private detectCircleOrbit(
    leftWrist: Keypoint,
    rightWrist: Keypoint,
    shoulderY: number,
    W: number,
    H: number,
    now: number,
  ): void {
    // the higher hand
    const cw = leftWrist.y < rightWrist.y ? leftWrist : rightWrist;
    if (cw.y > shoulderY) {
      // hand not raised above the shoulders → stop tracking
      this.hasCenter = false;
      this.hasCircleAngle = false;
      this.circleAccum = 0;
      return;
    }
    const nx = cw.x / W;
    const ny = cw.y / H;

    // EMA centre: settles on the middle of the circling motion.
    if (this.hasCenter) {
      this.centerX += (nx - this.centerX) * CIRCLE_CENTER_LERP;
      this.centerY += (ny - this.centerY) * CIRCLE_CENTER_LERP;
    } else {
      this.centerX = nx;
      this.centerY = ny;
      this.hasCenter = true;
    }

    const radius = Math.hypot(nx - this.centerX, ny - this.centerY);
    if (radius < CIRCLE_MIN_RADIUS) {
      // centre still converging, or hand not really circling
      this.hasCircleAngle = false;
      this.circleAccum = 0;
      return;
    }

    const ang = Math.atan2(ny - this.centerY, nx - this.centerX);
    if (this.hasCircleAngle) {
      let d = ang - this.circleAngle;
      while (d > Math.PI) {
        d -= 2 * Math.PI;
      }
      while (d < -Math.PI) {
        d += 2 * Math.PI;
      }
      this.circleAccum += d;
    }
    this.circleAngle = ang;
    this.hasCircleAngle = true;

    if (
      Math.abs(this.circleAccum) > CIRCLE_TRIGGER_RAD &&
      now - this.lastOrbitTime > ORBIT_COOLDOWN_MS
    ) {
      this.actions.orbit(this.circleAccum > 0 ? 1 : -1);
      this.lastOrbitTime = now;
      this.circleAccum = 0;
    }
  }
}
