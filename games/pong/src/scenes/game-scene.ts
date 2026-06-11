import * as THREE from "three";

import {
  AI_SPEED,
  ARC_LAND_MAX,
  ARC_LAND_MIN,
  ARC_PEAK,
  BALL_R,
  BALL_SPEED,
  BG,
  CAM_FOV,
  CAM_POS,
  CAM_RETURN_LERP,
  CAM_START_OFFSET_Y,
  CENTER_STRIPE,
  CLICK_DRAG_TOLERANCE_PX,
  COURT_D,
  COURT_W,
  DRAG_PAN_SCALE,
  GOAL_FLASH_DECAY,
  GOAL_Y,
  HAND_LERP_ACCEL,
  HAND_LERP_BASE,
  HAND_RANGE,
  HAND_TIMEOUT_MS,
  HIT_HALF_X,
  HIT_HALF_Y,
  INK,
  KEY_SPEED,
  LEGACY_FPS,
  MIN_VY_FRAC,
  NUDGE_DECAY,
  NUDGE_SCALE,
  PADDLE_RING_R,
  PADDLE_TUBE_R,
  PADDLE_X_MAX,
  PADDLE_Y,
  PADDLE_Z,
  PULSE_DECAY,
  PULSE_SCALE,
  SERVE_SPREAD,
  SHADOW_MAX_OPACITY,
  SQUASH,
  SQUASH_RECOVER,
  TABLE_THICK,
  WALL_X,
  WIN_SCORE,
} from "../shared/constants";

type Phase = "serving" | "rally" | "won";

/** Cosmetic hop: visual z parabola from the hit point to a landing y. */
type Arc = { fromY: number; toY: number };

export class GameScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  // ---- simulation state (x/y plane only — arc z is purely visual) -----------
  private phase: Phase = "serving";
  private ballPos = new THREE.Vector2(0, 0);
  private ballVel = new THREE.Vector2(0, 0);
  private arc: Arc | null = null;
  private playerX = 0;
  private aiX = 0;
  private scoreYou = 0;
  private scoreAi = 0;

  // ---- feel state ------------------------------------------------------------
  private playerPulse = 0;
  private aiPulse = 0;
  private camKick = new THREE.Vector3();
  private flashNear = 0; // player's goal line (conceded to AI)
  private flashFar = 0; // AI's goal line (conceded to player)

  // ---- display objects ---------------------------------------------------------
  private playerRing: THREE.Mesh;
  private aiRing: THREE.Mesh;
  private ball: THREE.Mesh;
  private shadowMat: THREE.MeshBasicMaterial;
  private shadow: THREE.Mesh;
  private flashNearMat: THREE.MeshBasicMaterial;
  private flashFarMat: THREE.MeshBasicMaterial;

  // ---- input -------------------------------------------------------------------
  private held = { left: false, right: false };
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private tablePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private planeHit = new THREE.Vector3();

  // Webcam hand tracking: latest wrist x ∈ [0,1] and when it was last seen.
  // While a hand is in frame it owns the paddle; pointer control resumes
  // HAND_TIMEOUT_MS after the last result (legacy never gave it back — bug).
  private handX: number | null = null;
  private handSeenAt = 0;
  private lastHandX: number | null = null;

  // Drag-to-pan camera offset; lerps back to rest while not dragging.
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private downAt = { x: 0, y: 0 };
  private camDrag = new THREE.Vector3(0, CAM_START_OFFSET_Y, 0);

  // ---- HUD ----------------------------------------------------------------------
  private scoreYouEl = el("score-you");
  private scoreAiEl = el("score-ai");
  private promptEl = el("prompt");
  private bannerEl = el("banner");

  constructor() {
    this.scene.background = new THREE.Color(BG);

    this.camera = new THREE.PerspectiveCamera(
      CAM_FOV,
      window.innerWidth / window.innerHeight,
      0.1,
      100,
    );
    // Legacy quirk preserved: the camera starts 1 unit above rest —
    // (0,-12,12) easing to (0,-13,12) — and the orientation is fixed here,
    // once, so drag-panning translates the view without re-aiming.
    this.camera.position.set(CAM_POS.x, CAM_POS.y + this.camDrag.y, CAM_POS.z);
    this.camera.lookAt(0, 0, 0);

    // Table: wireframe box edges, top face flush with the z=0 play plane.
    const ink = new THREE.MeshBasicMaterial({ color: INK });
    const table = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(COURT_W, COURT_D, TABLE_THICK)),
      new THREE.LineBasicMaterial({ color: INK }),
    );
    table.position.z = -TABLE_THICK / 2;
    this.scene.add(table);

    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(CENTER_STRIPE.w, CENTER_STRIPE.h), ink);
    stripe.position.z = 0.004;
    this.scene.add(stripe);

    // Goal-line flash bars (conceded-side feedback), invisible until a point lands.
    this.flashNearMat = flashMaterial();
    this.flashFarMat = flashMaterial();
    for (const [mat, y] of [
      [this.flashNearMat, -GOAL_Y],
      [this.flashFarMat, GOAL_Y],
    ] as const) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(COURT_W, 0.16), mat);
      bar.position.set(0, y, 0.004);
      this.scene.add(bar);
    }

    // Paddles: upright torus rings the ball flies through.
    const ringGeo = new THREE.TorusGeometry(PADDLE_RING_R, PADDLE_TUBE_R, 16, 100);
    this.playerRing = new THREE.Mesh(ringGeo, ink);
    this.playerRing.rotation.x = Math.PI / 2;
    this.playerRing.position.set(0, -PADDLE_Y, PADDLE_Z);
    this.aiRing = new THREE.Mesh(ringGeo, ink);
    this.aiRing.rotation.x = Math.PI / 2;
    this.aiRing.position.set(0, PADDLE_Y, PADDLE_Z);
    this.scene.add(this.playerRing, this.aiRing);

    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 16, 16), ink);
    this.ball.position.z = BALL_R;
    this.scene.add(this.ball);

    this.shadowMat = new THREE.MeshBasicMaterial({
      color: INK,
      transparent: true,
      opacity: SHADOW_MAX_OPACITY,
    });
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(BALL_R, 32), this.shadowMat);
    this.shadow.position.z = 0.01;
    this.scene.add(this.shadow);

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);

    this.syncHud();
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  // ---- input ---------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "Space") {
      e.preventDefault();
      this.confirm();
    } else if (e.code === "ArrowLeft" || e.code === "KeyA") {
      e.preventDefault();
      this.held.left = true;
    } else if (e.code === "ArrowRight" || e.code === "KeyD") {
      e.preventDefault();
      this.held.right = true;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "ArrowLeft" || e.code === "KeyA") this.held.left = false;
    else if (e.code === "ArrowRight" || e.code === "KeyD") this.held.right = false;
  };

  // Alt-tab swallows keyups — clear held movement so the paddle doesn't
  // autonomously slide to the clamp when focus returns.
  private onBlur = (): void => {
    this.held.left = false;
    this.held.right = false;
    this.dragging = false;
  };

  /** Wrist landmark x ∈ [0,1] from the webcam tracker (also the DEV hook). */
  handleHandPosition(x: number): void {
    this.handX = x;
    this.handSeenAt = performance.now();
  }

  /** Latest wrist x, or null once no hand has been seen for HAND_TIMEOUT_MS. */
  private currentHandX(): number | null {
    if (this.handX === null) return null;
    return performance.now() - this.handSeenAt < HAND_TIMEOUT_MS ? this.handX : null;
  }

  // Legacy gimmick: while dragging, the pointer pans the camera and the
  // paddle ignores it; otherwise pointermove drives the paddle (unless a
  // hand currently owns it).
  private onPointerMove = (e: PointerEvent): void => {
    if (this.dragging) {
      if (e.buttons === 0) {
        this.dragging = false; // button released outside the window
      } else {
        this.camDrag.x -= (e.clientX - this.lastPointer.x) * DRAG_PAN_SCALE;
        this.camDrag.y += (e.clientY - this.lastPointer.y) * DRAG_PAN_SCALE;
        this.lastPointer.x = e.clientX;
        this.lastPointer.y = e.clientY;
        return;
      }
    }
    if (this.currentHandX() !== null) return; // hand owns the paddle
    const x = this.pointerToTableX(e);
    if (x !== null) this.playerX = x;
  };

  private onPointerDown = (e: PointerEvent): void => {
    // Drag-pan is mouse-only: on touch there is no keyboard fallback, so
    // pointermove must keep driving the paddle (camera-less playability).
    if (e.pointerType === "mouse") {
      this.dragging = true;
      this.lastPointer.x = e.clientX;
      this.lastPointer.y = e.clientY;
      // Mouse serve is decided on pointerup (click vs drag) so starting a
      // camera pan doesn't also serve/rematch.
      this.downAt.x = e.clientX;
      this.downAt.y = e.clientY;
      return;
    }
    this.confirm();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.dragging && e.pointerType === "mouse") {
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
      if (moved < CLICK_DRAG_TOLERANCE_PX) this.confirm();
    }
    this.dragging = false;
  };

  /** Pointer x projected onto the table plane, clamped to paddle range. */
  private pointerToTableX(e: PointerEvent): number | null {
    this.ndc.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.tablePlane, this.planeHit);
    return hit ? clamp(hit.x, -PADDLE_X_MAX, PADDLE_X_MAX) : null;
  }

  /** Space / click / tap: rematch when won, serve when waiting. */
  private confirm(): void {
    if (this.phase === "won") {
      this.scoreYou = 0;
      this.scoreAi = 0;
      this.phase = "serving";
      this.syncHud();
    }
    if (this.phase === "serving") this.serve();
  }

  private serve(): void {
    // Always toward the player, ±SERVE_SPREAD rad of straight down.
    const angle = -Math.PI / 2 + (Math.random() * 2 - 1) * SERVE_SPREAD;
    this.ballVel.set(Math.cos(angle) * BALL_SPEED, Math.sin(angle) * BALL_SPEED);
    this.phase = "rally";
    this.syncHud();
  }

  // ---- simulation ------------------------------------------------------------

  update(dt: number): void {
    // Paddle input runs in every phase; ball/AI only during the rally.
    const keyDir = (this.held.right ? 1 : 0) - (this.held.left ? 1 : 0);
    if (keyDir !== 0) {
      this.playerX = clamp(this.playerX + keyDir * KEY_SPEED * dt, -PADDLE_X_MAX, PADDLE_X_MAX);
    }

    // Hand tracking owns the paddle while a hand is in frame. Legacy mapping:
    // targetX = (1 - wristX)·9 − 4.5 clamped ±4.5, smoothed by an adaptive
    // per-60fps-frame lerp of clamp(0.2 + |Δwrist|·10, 0, 1) — converted to dt.
    const hand = this.currentHandX();
    if (hand !== null) {
      const targetX = clamp((1 - hand) * HAND_RANGE - PADDLE_X_MAX, -PADDLE_X_MAX, PADDLE_X_MAX);
      const wristSpeed = this.lastHandX === null ? 0 : Math.abs(hand - this.lastHandX);
      this.lastHandX = hand;
      const perFrame = clamp(HAND_LERP_BASE + wristSpeed * HAND_LERP_ACCEL, 0, 1);
      this.playerX += (targetX - this.playerX) * frameLerp(perFrame, dt);
    } else {
      this.lastHandX = null;
    }

    if (this.phase === "rally") {
      this.updateAi(dt);
      this.updateBall(dt);
    }

    this.updateVisuals(dt);
  }

  private updateAi(dt: number): void {
    // Chase ball x, clamped to never overshoot it.
    const dx = this.ballPos.x - this.aiX;
    const step = clamp(dx, -AI_SPEED * dt, AI_SPEED * dt);
    this.aiX = clamp(this.aiX + step, -PADDLE_X_MAX, PADDLE_X_MAX);
  }

  private updateBall(dt: number): void {
    const pos = this.ballPos;
    const vel = this.ballVel;
    pos.addScaledVector(vel, dt);

    // Side walls.
    if (Math.abs(pos.x) >= WALL_X && Math.sign(vel.x) === Math.sign(pos.x)) {
      vel.x = -vel.x;
      pos.x = clamp(pos.x, -WALL_X, WALL_X);
      this.squashBall("x");
    }

    // Paddle hits — only when the ball is moving toward that paddle.
    if (vel.y < 0 && hitsPaddle(pos, this.playerX, -PADDLE_Y)) {
      this.onPaddleHit("player");
    } else if (vel.y > 0 && hitsPaddle(pos, this.aiX, PADDLE_Y)) {
      this.onPaddleHit("ai");
    }

    // Arc landing (visual only).
    if (this.arc && arcProgress(this.arc, pos.y) >= 1) {
      this.arc = null;
      this.squashBall("z");
    }

    // Scoring.
    if (pos.y > GOAL_Y) this.onPoint("you");
    else if (pos.y < -GOAL_Y) this.onPoint("ai");
  }

  private onPaddleHit(side: "player" | "ai"): void {
    const paddleX = side === "player" ? this.playerX : this.aiX;
    const paddleY = side === "player" ? -PADDLE_Y : PADDLE_Y;
    const towardY = side === "player" ? 1 : -1;

    this.ballVel.copy(reflectOffPaddle(this.ballPos, paddleX, paddleY, towardY));
    this.arc = {
      fromY: this.ballPos.y,
      toY: towardY * (ARC_LAND_MIN + Math.random() * (ARC_LAND_MAX - ARC_LAND_MIN)),
    };

    // Feel: ring pop, ball squash along travel, tiny camera kick with the ball.
    if (side === "player") this.playerPulse = 1;
    else this.aiPulse = 1;
    this.squashBall("y");
    this.camKick.set(this.ballVel.x * NUDGE_SCALE, this.ballVel.y * NUDGE_SCALE, 0);
  }

  private onPoint(scorer: "you" | "ai"): void {
    if (scorer === "you") {
      this.scoreYou += 1;
      this.flashFar = 1;
      popScore(this.scoreYouEl);
    } else {
      this.scoreAi += 1;
      this.flashNear = 1;
      popScore(this.scoreAiEl);
    }

    this.ballPos.set(0, 0);
    this.ballVel.set(0, 0);
    this.arc = null;
    this.phase = this.scoreYou >= WIN_SCORE || this.scoreAi >= WIN_SCORE ? "won" : "serving";
    this.syncHud();
  }

  // ---- visual effects ----------------------------------------------------------

  private squashBall(axis: "x" | "y" | "z"): void {
    const s = this.ball.scale;
    s.set(1 + SQUASH / 2, 1 + SQUASH / 2, 1 + SQUASH / 2);
    s[axis] = 1 - SQUASH;
  }

  private updateVisuals(dt: number): void {
    this.playerPulse *= Math.exp(-PULSE_DECAY * dt);
    this.aiPulse *= Math.exp(-PULSE_DECAY * dt);
    this.playerRing.position.x = this.playerX;
    this.playerRing.scale.setScalar(1 + PULSE_SCALE * this.playerPulse);
    this.aiRing.position.x = this.aiX;
    this.aiRing.scale.setScalar(1 + PULSE_SCALE * this.aiPulse);

    const arcZ = this.arc ? arcHeight(this.arc, this.ballPos.y) : 0;
    this.ball.position.set(this.ballPos.x, this.ballPos.y, BALL_R + arcZ);
    this.ball.scale.lerp(UNIT_SCALE, 1 - Math.exp(-SQUASH_RECOVER * dt));

    this.shadow.position.set(this.ballPos.x, this.ballPos.y, 0.01);
    this.shadowMat.opacity = SHADOW_MAX_OPACITY * Math.max(0, 1 - arcZ / ARC_PEAK);

    this.flashNear *= Math.exp(-GOAL_FLASH_DECAY * dt);
    this.flashFar *= Math.exp(-GOAL_FLASH_DECAY * dt);
    this.flashNearMat.opacity = 0.85 * this.flashNear;
    this.flashFarMat.opacity = 0.85 * this.flashFar;

    // Drag-pan offset eases back to rest only while not dragging (legacy:
    // 0.1 per 60fps frame). Orientation stays fixed — pan, don't re-aim.
    if (!this.dragging) this.camDrag.lerp(V3_ZERO, frameLerp(CAM_RETURN_LERP, dt));
    this.camKick.multiplyScalar(Math.exp(-NUDGE_DECAY * dt));
    this.camera.position.set(
      CAM_POS.x + this.camDrag.x + this.camKick.x,
      CAM_POS.y + this.camDrag.y + this.camKick.y,
      CAM_POS.z + this.camDrag.z + this.camKick.z,
    );
  }

  // ---- HUD -----------------------------------------------------------------

  private syncHud(): void {
    this.scoreYouEl.textContent = String(this.scoreYou);
    this.scoreAiEl.textContent = String(this.scoreAi);
    this.promptEl.style.opacity = this.phase === "serving" ? "1" : "0";

    if (this.phase === "won") {
      const strong = this.scoreYou > this.scoreAi ? "you win" : "ai wins";
      this.bannerEl.replaceChildren(strong, smallNote("press space or tap for rematch"));
      this.bannerEl.style.opacity = "1";
    } else {
      this.bannerEl.style.opacity = "0";
    }
  }
}

// ---- module helpers (pure) --------------------------------------------------

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const V3_ZERO = new THREE.Vector3(0, 0, 0);

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Convert a legacy per-frame (60fps) lerp factor into a dt-correct one. */
function frameLerp(perFrame: number, dt: number): number {
  return 1 - Math.pow(1 - perFrame, dt * LEGACY_FPS);
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function smallNote(text: string): HTMLElement {
  const node = document.createElement("small");
  node.textContent = text;
  return node;
}

function popScore(node: HTMLElement): void {
  node.classList.remove("pop");
  void node.offsetWidth; // restart the CSS animation
  node.classList.add("pop");
}

function flashMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0 });
}

function hitsPaddle(ball: THREE.Vector2, paddleX: number, paddleY: number): boolean {
  // Hitbox deliberately larger than the visible ring — keep it generous.
  return Math.abs(ball.y - paddleY) < HIT_HALF_Y && Math.abs(ball.x - paddleX) < HIT_HALF_X;
}

/**
 * Angle-of-incidence return: reflect by the hit offset from paddle center,
 * with the toward-opponent component forced positive and floored at
 * MIN_VY_FRAC so a graze can't produce a horizontal crawl. Speed stays
 * BALL_SPEED exactly.
 */
function reflectOffPaddle(
  ball: THREE.Vector2,
  paddleX: number,
  paddleY: number,
  towardY: 1 | -1,
): THREE.Vector2 {
  const angle = Math.atan2(ball.y - paddleY, ball.x - paddleX);
  const vyFrac = Math.max(Math.abs(Math.sin(angle)), MIN_VY_FRAC);
  const vy = towardY * vyFrac * BALL_SPEED;
  const vx = Math.sign(Math.cos(angle)) * Math.sqrt(BALL_SPEED * BALL_SPEED - vy * vy);
  return new THREE.Vector2(vx, vy);
}

function arcProgress(arc: Arc, y: number): number {
  return clamp((y - arc.fromY) / (arc.toY - arc.fromY), 0, 1);
}

/** Parabola peaking at ARC_PEAK halfway through the hop. */
function arcHeight(arc: Arc, y: number): number {
  const p = arcProgress(arc, y);
  return 4 * ARC_PEAK * p * (1 - p);
}
