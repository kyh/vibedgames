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
  TPOSE_LEVEL_SLACK,
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

/** The keypoints every detector reads, plus the derived frame measures. */
interface Body {
  leftWrist: Keypoint;
  rightWrist: Keypoint;
  leftShoulder: Keypoint;
  rightShoulder: Keypoint;
  nose: Keypoint;
  shoulderWidth: number;
  shoulderY: number;
  hipY: number;
  W: number;
  H: number;
}

/** Null when any required keypoint is missing from the frame. */
const readBody = (pose: Pose): Body | null => {
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
    return null;
  }
  return {
    H: pose.height || 1,
    W: pose.width || 1,
    hipY: (leftHip.y + rightHip.y) / 2,
    leftShoulder,
    leftWrist,
    nose,
    rightShoulder,
    rightWrist,
    shoulderWidth: Math.abs(rightShoulder.x - leftShoulder.x),
    shoulderY: (leftShoulder.y + rightShoulder.y) / 2,
  };
};

/** Nose offset from neutral, dead-zoned, as a steer direction. */
const steerDir = (off: number): -1 | 0 | 1 => {
  if (off > NOSE_DEAD_ZONE) {
    return 1;
  }
  if (off < -NOSE_DEAD_ZONE) {
    return -1;
  }
  return 0;
};

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
  private actionsPaused = false;
  private neutralRequired = false;

  constructor(actions: PoseActions) {
    this.actions = actions;
  }

  /** Keep detection/calibration live, then require a fresh body gesture after pause. */
  setActionsPaused(paused: boolean): void {
    this.actionsPaused = paused;
    this.neutralRequired = true;
    this.hasPrev = false;
    this.hasCenter = false;
    this.hasCircleAngle = false;
    this.circleAccum = 0;
  }

  /** Re-run neutral calibration (bound to the recenter key / a settle pose). */
  recenter(): void {
    this.calibCount = 0;
    this.sumNeutralX = 0;
    this.sumShoulder = 0;
    this.hasPrev = false;
  }

  handlePose = (pose: Pose, ctx: CanvasRenderingContext2D | null): void => {
    // Overlay guides went with pose-to-pick; PoseCamera still draws the skeleton.
    void ctx;
    const body = readBody(pose);
    if (!body) {
      this.hasPrev = false;
      return;
    }

    const now = performance.now();
    const dt = this.hasPrev ? Math.max(0.001, (now - this.lastTime) / 1000) : 0.033;

    this.calibrate(body);

    if (this.actionsPaused || this.neutralRequired) {
      if (!this.actionsPaused && this.isNeutral(body)) {
        this.neutralRequired = false;
        this.holdArmed = true;
        this.powerArmed = true;
      }
      this.hasPrev = false;
      this.lastTime = now;
      return;
    }

    if (this.calibCount >= CALIB_FRAMES) {
      this.actions.steer(steerDir(1 - body.nose.x / body.W - this.neutralX));
      this.detectCircleOrbit(body.leftWrist, body.rightWrist, body.shoulderY, body.W, body.H, now);
      this.detectRotate(body, now);
      this.detectHold(body, now);
      this.detectPower(body, now);
    }

    this.detectCatch(body, dt, now);
    this.lastTime = now;
  };

  /** Average the first frames into the neutral nose-x and resting shoulder width. */
  private calibrate({ nose, shoulderWidth, W }: Body): void {
    if (this.calibCount >= CALIB_FRAMES) {
      return;
    }
    this.sumNeutralX += 1 - nose.x / W;
    this.sumShoulder += shoulderWidth;
    this.calibCount += 1;
    if (this.calibCount === CALIB_FRAMES) {
      this.neutralX = this.sumNeutralX / CALIB_FRAMES;
      this.baseShoulder = this.sumShoulder / CALIB_FRAMES;
    }
  }

  /** Facing forward, hands down and uncrossed: the pose that re-arms after a pause. */
  private isNeutral(body: Body): boolean {
    const {
      nose,
      leftWrist,
      rightWrist,
      leftShoulder,
      rightShoulder,
      shoulderWidth,
      shoulderY,
      W,
    } = body;
    const off = 1 - nose.x / W - this.neutralX;
    const uncrossed =
      Math.sign(rightWrist.x - leftWrist.x) === Math.sign(rightShoulder.x - leftShoulder.x);
    // Wrists must clear the T-pose level band, not merely dip below the
    // shoulders, or a T-pose held across the pause re-arms and fires power.
    const wristsDown = shoulderY + shoulderWidth * TPOSE_LEVEL_SLACK;
    return (
      Math.abs(off) <= NOSE_DEAD_ZONE &&
      shoulderWidth >= ROTATE_SQUEEZE_FRACTION * this.baseShoulder &&
      leftWrist.y > wristsDown &&
      rightWrist.y > wristsDown &&
      uncrossed
    );
  }

  /** Turn sideways (shoulders squeeze) to rotate. */
  private detectRotate({ shoulderWidth }: Body, now: number): void {
    if (
      this.baseShoulder > 0 &&
      shoulderWidth < ROTATE_SQUEEZE_FRACTION * this.baseShoulder &&
      now - this.lastRotateTime > ROTATE_COOLDOWN_MS &&
      this.actions.rotate()
    ) {
      this.lastRotateTime = now;
    }
  }

  /** Crossed wrists at chest height hold/swap the piece. */
  private detectHold(body: Body, now: number): void {
    const { leftWrist, rightWrist, leftShoulder, rightShoulder, shoulderY, hipY } = body;
    const shoulderSign = Math.sign(rightShoulder.x - leftShoulder.x);
    const wristSign = Math.sign(rightWrist.x - leftWrist.x);
    const wristsAtChest =
      leftWrist.y > shoulderY &&
      leftWrist.y < hipY &&
      rightWrist.y > shoulderY &&
      rightWrist.y < hipY;
    const crossed = shoulderSign !== 0 && wristSign === -shoulderSign && wristsAtChest;
    if (!crossed) {
      this.holdArmed = true;
    }
    if (this.holdArmed && crossed && now - this.lastHoldTime > HOLD_COOLDOWN_MS) {
      this.actions.hold();
      this.holdArmed = false;
      this.lastHoldTime = now;
    }
  }

  /** T-pose (wrists out past the shoulders at shoulder height) spends a power charge. */
  private detectPower(
    { leftWrist, rightWrist, shoulderWidth, shoulderY, W }: Body,
    now: number,
  ): void {
    const out = TPOSE_WRIST_OUT * W;
    const wristSpread = Math.abs(rightWrist.x - leftWrist.x);
    const wristsLevel =
      Math.abs(leftWrist.y - shoulderY) < shoulderWidth * TPOSE_LEVEL_SLACK &&
      Math.abs(rightWrist.y - shoulderY) < shoulderWidth * TPOSE_LEVEL_SLACK;
    const tpose = wristSpread > shoulderWidth + 2 * out && wristsLevel;
    if (!tpose) {
      this.powerArmed = true;
    }
    if (this.powerArmed && tpose && now - this.lastPowerTime > POWER_COOLDOWN_MS) {
      this.actions.power();
      this.powerArmed = false;
      this.lastPowerTime = now;
    }
  }

  /** Both wrists thrust up fast: catch the collapse / start. */
  private detectCatch({ leftWrist, rightWrist, H }: Body, dt: number, now: number): void {
    const avgWristY = (leftWrist.y + rightWrist.y) / 2;
    if (this.hasPrev) {
      // +up, normalised per second.
      const upVel = (this.prevWristY - avgWristY) / dt / H;
      if (upVel > CATCH_WRIST_VELOCITY && now - this.lastCatchTime > CATCH_COOLDOWN_MS) {
        this.actions.catchCollapse();
        this.lastCatchTime = now;
      }
    }
    this.prevWristY = avgWristY;
    this.hasPrev = true;
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
    // The higher hand.
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
