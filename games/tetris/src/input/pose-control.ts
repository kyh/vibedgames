import { COLS } from "../shared/constants";
import type { Keypoint, Pose } from "./camera";

/**
 * Pose → game-action interpretation (plain TS port of the legacy
 * `handlePoseDetected` in app.tsx). All box math, thresholds, colors and
 * evaluation order are verbatim from the legacy source:
 *
 * - next-piece poses, checked in legacy order I, T, O, S, Z, L, J — a held
 *   pose fires chooseNext EVERY detected frame (continuous pinning)
 * - rotation: |leftShoulder.x − rightShoulder.x| < 50px, 600ms cooldown,
 *   cooldown restarts only when the rotation actually applied
 * - nose-x: targetX = floor((1 − nose.x / refW) * COLS), absolute teleport
 * - dashed 5px guide boxes drawn on the camera overlay each frame.
 *
 * Legacy quirk preserved: several boxes and the nose divisor used the GAME
 * canvas dimensions — min(700, innerWidth) × innerHeight — captured once at
 * startup (no resize handling), not the camera frame size.
 */

/** Game actions a detected pose can drive (wired to GameScene). */
export type PoseActions = {
  /** Absolute column for the active piece (legacy nose-x teleport). */
  setColumn(targetX: number): void;
  /** Clockwise rotate; reports whether the rotation was applied. */
  rotate(): boolean;
  /** Pin the NEXT piece — called every detected frame while a pose is held. */
  chooseNext(idx: number): void;
};

type Box = { x: number; y: number; width: number; height: number };

/** Legacy rotation debounce (lastRotationTime). */
const ROTATE_COOLDOWN_MS = 600;
/** Legacy sideways-turn trigger: shoulder distance below this, in px. */
const ROTATE_SHOULDER_PX = 50;

/** Legacy used strict inequalities on all four edges. */
const inBox = (kp: Keypoint, box: Box): boolean =>
  kp.x > box.x && kp.x < box.x + box.width && kp.y > box.y && kp.y < box.y + box.height;

const drawShapeGuide = (ctx: CanvasRenderingContext2D | null, box: Box, color: string): void => {
  if (!ctx) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.setLineDash([5, 5]);
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.setLineDash([]);
};

export class PoseControls {
  readonly actions: PoseActions;
  // Legacy canvasWidth/canvasHeight: frozen at mount, never resized.
  private readonly refW = Math.min(700, window.innerWidth);
  private readonly refH = window.innerHeight;
  private lastRotationTime = 0;

  constructor(actions: PoseActions) {
    this.actions = actions;
  }

  /** Bound method so it can be handed to PoseCamera (and the DEV hook) directly. */
  handlePose = (pose: Pose, ctx: CanvasRenderingContext2D | null): void => {
    const find = (name: string): Keypoint | undefined =>
      pose.keypoints.find((kp) => kp.name === name);

    const leftWrist = find("left_wrist");
    const rightWrist = find("right_wrist");
    const leftShoulder = find("left_shoulder");
    const rightShoulder = find("right_shoulder");
    const leftHip = find("left_hip");
    const rightHip = find("right_hip");
    const leftEye = find("left_eye");
    const rightEye = find("right_eye");
    const leftEar = find("left_ear");
    const rightEar = find("right_ear");
    const nose = find("nose");

    if (
      !leftWrist ||
      !rightWrist ||
      !leftShoulder ||
      !rightShoulder ||
      !leftHip ||
      !rightHip ||
      !leftEye ||
      !rightEye ||
      !leftEar ||
      !rightEar ||
      !nose
    ) {
      return;
    }

    const shoulderWidth = Math.abs(rightShoulder.x - leftShoulder.x);
    const centerX = (leftShoulder.x + rightShoulder.x) / 2;

    // Legacy assigned nextShapeRef silently per box (last write wins); calling
    // chooseNext per box would re-trigger the preview pulse ~30x/s when guide
    // boxes overlap. Record the last match, fire once per frame below.
    let matched: number | null = null;

    // I shape: Both arms straight up
    const iShapeBox: Box = {
      x: leftEar.x, // Start at left ear
      y: 0, // Start at top of canvas
      width: rightEar.x - leftEar.x, // Width spans between ears
      height: leftEar.y, // Extend down to ear level
    };
    drawShapeGuide(ctx, iShapeBox, "rgba(255, 0, 0, 0.5)");
    if (inBox(leftWrist, iShapeBox) && inBox(rightWrist, iShapeBox)) {
      matched = 0;
    }

    // T shape: Extend arms straight out to sides
    const tShapeBox: Box = {
      x: 0, // Start at left edge of canvas
      y: leftShoulder.y - shoulderWidth * 0.3, // Center the box on shoulders
      width: this.refW, // Extend full width of canvas
      height: shoulderWidth * 0.6, // Height centered on shoulders
    };
    drawShapeGuide(ctx, tShapeBox, "rgba(0, 0, 255, 0.5)");
    if (inBox(leftWrist, tShapeBox) && inBox(rightWrist, tShapeBox)) {
      matched = 2;
    }

    // O shape: Hands between torso forming an X
    const oShapeBox: Box = {
      x: centerX - shoulderWidth * 0.25, // Center between shoulders
      y: leftShoulder.y, // Start at shoulder level
      width: shoulderWidth * 0.5, // Width is half of shoulder width
      height: shoulderWidth * 0.75, // Height extends down from shoulders
    };
    drawShapeGuide(ctx, oShapeBox, "rgba(0, 255, 0, 0.5)");
    if (inBox(leftWrist, oShapeBox) && inBox(rightWrist, oShapeBox)) {
      matched = 1;
    }

    // S shape: Right wrist above right shoulder, left wrist near left waist
    const sShapeBox1: Box = {
      x: 0, // Start at left edge of canvas
      y: 0, // Start at top of canvas
      width: rightEye.x * 0.75, // Extend from left edge toward right eye
      height: rightEye.y * 0.75, // Extend down toward eye level
    };
    const sShapeBox2: Box = {
      x: leftHip.x, // Start at left hip
      y: leftHip.y * 0.8, // Start at hip level
      width: this.refW - leftHip.x, // Extend to right edge of canvas
      height: this.refH - leftHip.y, // Extend to bottom of canvas
    };
    drawShapeGuide(ctx, sShapeBox1, "rgba(255, 255, 0, 0.5)");
    drawShapeGuide(ctx, sShapeBox2, "rgba(255, 255, 0, 0.5)");
    if (inBox(rightWrist, sShapeBox1) && inBox(leftWrist, sShapeBox2)) {
      matched = 3;
    }

    // Z shape: Left wrist above left shoulder, right wrist near right waist
    const zShapeBox1: Box = {
      x: this.refW - (this.refW - leftEye.x) * 0.75, // Start 0.75 distance from right edge
      y: 0, // Start at top of canvas
      width: (this.refW - leftEye.x) * 0.75, // Width is 0.75 of distance to left eye
      height: leftEye.y * 0.75, // Extend down to eye level
    };
    const zShapeBox2: Box = {
      x: 0, // Start at left edge of canvas
      y: rightHip.y * 0.8, // Start at right hip level
      width: rightHip.x, // Extend from right hip to left edge
      height: this.refH - rightHip.y, // Extend to bottom of canvas
    };
    drawShapeGuide(ctx, zShapeBox1, "rgba(255, 0, 255, 0.5)");
    drawShapeGuide(ctx, zShapeBox2, "rgba(255, 0, 255, 0.5)");
    if (inBox(leftWrist, zShapeBox1) && inBox(rightWrist, zShapeBox2)) {
      matched = 4;
    }

    // L shape: Left arm up and right arm out
    const lShapeBox1: Box = {
      x: leftShoulder.x - shoulderWidth * 0.25, // Left side box
      y: 0, // Start at top of canvas
      width: shoulderWidth * 0.5, // Width similar to I shape
      height: leftShoulder.y, // Extend down to shoulder height
    };
    const lShapeBox2: Box = {
      x: 0, // Start at left edge of canvas
      y: rightShoulder.y - shoulderWidth * 0.3, // Same height as T shape
      width: rightShoulder.x, // Extend to right shoulder
      height: shoulderWidth * 0.6, // Same height as T shape
    };
    drawShapeGuide(ctx, lShapeBox1, "rgba(0, 255, 255, 0.5)");
    drawShapeGuide(ctx, lShapeBox2, "rgba(0, 255, 255, 0.5)");
    if (inBox(leftWrist, lShapeBox1) && inBox(rightWrist, lShapeBox2)) {
      matched = 5;
    }

    // J shape: Right arm up and left arm out
    const jShapeBox1: Box = {
      x: rightShoulder.x - shoulderWidth * 0.25, // Right side box
      y: 0, // Start at top of canvas
      width: shoulderWidth * 0.5, // Width similar to I shape
      height: rightShoulder.y, // Extend down to shoulder height
    };
    const jShapeBox2: Box = {
      x: leftShoulder.x, // Start at left shoulder
      y: leftShoulder.y - shoulderWidth * 0.3, // Same height as T shape
      width: this.refW - leftShoulder.x, // Extend to right edge
      height: shoulderWidth * 0.6, // Same height as T shape
    };
    drawShapeGuide(ctx, jShapeBox1, "rgba(255, 165, 0, 0.5)");
    drawShapeGuide(ctx, jShapeBox2, "rgba(255, 165, 0, 0.5)");
    if (inBox(rightWrist, jShapeBox1) && inBox(leftWrist, jShapeBox2)) {
      matched = 6;
    }

    // Check for rotation by measuring distance between shoulders
    const shoulderDistance = Math.abs(leftShoulder.x - rightShoulder.x);
    const isRotating =
      shoulderDistance < ROTATE_SHOULDER_PX &&
      Date.now() - this.lastRotationTime > ROTATE_COOLDOWN_MS;
    if (isRotating && this.actions.rotate()) {
      // Legacy only restarted the cooldown when the rotation actually fit.
      this.lastRotationTime = Date.now();
    }

    if (matched !== null) this.actions.chooseNext(matched);

    // Update block position based on nose position (mirrored, absolute).
    const noseXPercent = 1 - nose.x / this.refW;
    const targetX = Math.floor(noseXPercent * COLS);
    this.actions.setColumn(targetX);
  };
}
