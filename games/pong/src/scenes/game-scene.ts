import * as THREE from "three";

import { ParticlePool } from "../fx/particles";
import { sfx } from "../fx/sfx";
import { RingPool } from "../fx/shock-rings";
import {
  AI_SPEED_FRAC,
  ARC_LAND_MAX,
  ARC_LAND_MIN,
  ARC_PEAK,
  AUTO_SERVE_S,
  BALL_R,
  BG,
  BURST_GOAL,
  BURST_PADDLE,
  BURST_WALL,
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
  HIT_STOP_GOAL,
  HIT_STOP_PADDLE,
  HIT_STOP_WIN,
  INK,
  INVERT_FLASH_S,
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
  RALLY_SPEED_BASE,
  RALLY_SPEED_MAX,
  RALLY_SPEED_STEP,
  RING_GOAL,
  RING_PADDLE,
  SERVE_PULSE_FREQ,
  SERVE_PULSE_SCALE,
  SERVE_SPREAD,
  SHADOW_ARC_GROW,
  SHADOW_MAX_OPACITY,
  SHAKE_FREQ,
  SHAKE_MAX_OFFSET,
  SHAKE_MAX_ROLL,
  SQUASH,
  SQUASH_RECOVER,
  TRAIL_LIFE,
  TRAIL_RATE,
  TRAIL_SIZE,
  TRAUMA_DECAY,
  TRAUMA_GOAL,
  TRAUMA_PADDLE,
  TRAUMA_WALL,
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
  private rallySpeed = RALLY_SPEED_BASE;
  private rallyHits = 0;
  private serveAt: number | null = null; // elapsed time of the next auto-serve

  // ---- feel state ------------------------------------------------------------
  private elapsed = 0;
  private freeze = 0; // hit-stop: sim halts, rendering continues
  private playerPulse = 0;
  private aiPulse = 0;
  private camKick = new THREE.Vector3();
  private trauma = 0; // 0-1; shake amplitude = trauma²
  private shakeTime = 0;
  private baseRotation = new THREE.Euler();
  private invertFlash = 0; // seconds left of full-screen ink/paper swap
  private flashNear = 0; // player's goal line (conceded to AI)
  private flashFar = 0; // AI's goal line (conceded to player)
  private trailAcc = 0;
  private particles: ParticlePool;
  private rings: RingPool;

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
    // Shake rolls around the view axis each frame, relative to this rest pose.
    this.baseRotation.copy(this.camera.rotation);

    // One key light, for the ball's Phong glint only — every other material
    // is unlit. The glint's gradient is what the dither pass bites into.
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(-4, -8, 9);
    this.scene.add(key);

    // Table: a single flat outline on the z=0 play plane (the old box edges
    // drew a second, lower rectangle that doubled every side line).
    const ink = new THREE.MeshBasicMaterial({ color: INK });
    const table = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(COURT_W, COURT_D)),
      new THREE.LineBasicMaterial({ color: INK }),
    );
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

    // Near-black Phong: reads as ink after dithering, but the specular
    // highlight gives the sphere a dithered glint that sells the form.
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 16, 16),
      new THREE.MeshPhongMaterial({ color: 0x111111, specular: 0xbbbbbb, shininess: 40 }),
    );
    this.ball.position.z = BALL_R;
    this.scene.add(this.ball);

    // Soft radial-gradient shadow — the falloff dithers into a speckle edge.
    this.shadowMat = new THREE.MeshBasicMaterial({
      map: softCircleTexture(),
      transparent: true,
      opacity: SHADOW_MAX_OPACITY,
      depthWrite: false,
    });
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(BALL_R * 5, BALL_R * 5), this.shadowMat);
    this.shadow.position.z = 0.01;
    this.scene.add(this.shadow);

    this.particles = new ParticlePool(this.scene);
    this.rings = new RingPool(this.scene);

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
    this.rallySpeed = RALLY_SPEED_BASE;
    this.rallyHits = 0;
    this.serveAt = null;
    this.ballVel.set(Math.cos(angle) * this.rallySpeed, Math.sin(angle) * this.rallySpeed);
    this.phase = "rally";
    sfx.serve();
    this.syncHud();
  }

  // ---- simulation ------------------------------------------------------------

  update(dt: number): void {
    this.elapsed += dt;
    this.invertFlash = Math.max(0, this.invertFlash - dt);

    // Hit-stop: the sim and visual decays hold for a beat while rendering
    // continues. Deliberate exceptions that keep ticking: the invert flash
    // (above — so the goal flash ends inside the goal freeze), the
    // auto-serve clock (elapsed), the shake oscillator (a frozen offset
    // reads as a glitch, not a shake), and the drag-pan camera (user input).
    if (this.freeze > 0) {
      this.freeze -= dt;
      this.shakeTime += dt;
      this.composeCamera();
      return;
    }

    if (this.phase === "serving" && this.serveAt !== null && this.elapsed >= this.serveAt) {
      this.serve();
    }

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
    // Chase ball x, clamped to never overshoot it. Speed tracks the rally
    // ramp at a fixed fraction, so the matchup stays constant as pace rises.
    const aiSpeed = this.rallySpeed * AI_SPEED_FRAC;
    const dx = this.ballPos.x - this.aiX;
    const step = clamp(dx, -aiSpeed * dt, aiSpeed * dt);
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
      this.trauma = Math.min(1, this.trauma + TRAUMA_WALL);
      this.particles.burst({
        x: pos.x,
        y: pos.y,
        z: this.ballHeight(),
        dirX: -Math.sign(pos.x),
        ...BURST_WALL,
      });
      sfx.wall();
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

    // Every return raises the rally speed — the pace ramp.
    this.rallyHits += 1;
    this.rallySpeed = Math.min(RALLY_SPEED_MAX, this.rallySpeed + RALLY_SPEED_STEP);
    this.ballVel.copy(reflectOffPaddle(this.ballPos.x, paddleX, towardY, this.rallySpeed));
    this.arc = {
      fromY: this.ballPos.y,
      toY: towardY * (ARC_LAND_MIN + Math.random() * (ARC_LAND_MAX - ARC_LAND_MIN)),
    };

    // Feel: hit-stop beat, ring pop, ball squash along travel, camera kick
    // with the ball plus a pinch of trauma shake, ink sparks fanning out
    // along the return, a contact ring on the table, climbing-pitch blip.
    this.freeze = HIT_STOP_PADDLE;
    this.trauma = Math.min(1, this.trauma + TRAUMA_PADDLE);
    if (side === "player") this.playerPulse = 1;
    else this.aiPulse = 1;
    this.squashBall("y");
    this.camKick.set(this.ballVel.x * NUDGE_SCALE, this.ballVel.y * NUDGE_SCALE, 0);
    this.particles.burst({
      x: this.ballPos.x,
      y: this.ballPos.y,
      z: this.ballHeight(),
      dirX: this.ballVel.x,
      dirY: this.ballVel.y,
      ...BURST_PADDLE,
    });
    this.rings.spawn({ x: this.ballPos.x, y: paddleY, ...RING_PADDLE });
    sfx.paddleHit(this.rallyHits);
  }

  private onPoint(scorer: "you" | "ai"): void {
    const goalY = scorer === "you" ? GOAL_Y : -GOAL_Y;
    const crossX = clamp(this.ballPos.x, -WALL_X, WALL_X);
    if (scorer === "you") {
      this.scoreYou += 1;
      this.flashFar = 1;
      popScore(this.scoreYouEl);
    } else {
      this.scoreAi += 1;
      this.flashNear = 1;
      popScore(this.scoreAiEl);
    }

    // The point is the loudest beat: screen inverts for a flash, sim holds,
    // heavy shake, an ink explosion and shockwave at the crossing point.
    this.invertFlash = INVERT_FLASH_S;
    this.trauma = Math.min(1, this.trauma + TRAUMA_GOAL);
    this.particles.burst({
      x: crossX,
      y: goalY,
      z: BALL_R,
      dirY: -Math.sign(goalY),
      ...BURST_GOAL,
    });
    this.rings.spawn({ x: crossX, y: goalY, ...RING_GOAL });

    this.ballPos.set(0, 0);
    this.ballVel.set(0, 0);
    this.arc = null;
    const won = this.scoreYou >= WIN_SCORE || this.scoreAi >= WIN_SCORE;
    this.phase = won ? "won" : "serving";
    this.freeze = won ? HIT_STOP_WIN : HIT_STOP_GOAL;
    if (won) sfx.win(this.scoreYou > this.scoreAi);
    else {
      sfx.score(scorer === "you");
      this.serveAt = this.elapsed + AUTO_SERVE_S;
    }
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
    // Waiting to serve: the ball breathes — anticipation instead of a dead prop.
    if (this.phase === "serving") {
      this.ball.scale.setScalar(1 + SERVE_PULSE_SCALE * Math.sin(this.elapsed * SERVE_PULSE_FREQ));
    }

    // Trail: stationary ghosts dropped at a fixed rate, so a faster ball
    // stretches them into a longer streak. Each dissolves ink → paper.
    // Ghosts spawned in the same frame are back-projected along velocity to
    // their ideal emission times, keeping trail spacing frame-rate-invariant.
    if (this.phase === "rally") {
      this.trailAcc += dt * TRAIL_RATE;
      const ghosts = Math.floor(this.trailAcc);
      this.trailAcc -= ghosts;
      for (let i = 0; i < ghosts; i++) {
        const back = (i + this.trailAcc) / TRAIL_RATE;
        this.particles.ghost(
          this.ballPos.x - this.ballVel.x * back,
          this.ballPos.y - this.ballVel.y * back,
          BALL_R + arcZ,
          TRAIL_SIZE,
          TRAIL_LIFE,
        );
      }
    }
    this.particles.update(dt);
    this.rings.update(dt);

    this.shadow.position.set(this.ballPos.x, this.ballPos.y, 0.01);
    this.shadow.scale.setScalar(1 + (arcZ / ARC_PEAK) * SHADOW_ARC_GROW);
    this.shadowMat.opacity = SHADOW_MAX_OPACITY * Math.max(0, 1 - arcZ / ARC_PEAK);

    this.flashNear *= Math.exp(-GOAL_FLASH_DECAY * dt);
    this.flashFar *= Math.exp(-GOAL_FLASH_DECAY * dt);
    this.flashNearMat.opacity = 0.85 * this.flashNear;
    this.flashFarMat.opacity = 0.85 * this.flashFar;

    // Drag-pan offset eases back to rest only while not dragging (legacy:
    // 0.1 per 60fps frame). Orientation stays fixed — pan, don't re-aim.
    if (!this.dragging) this.camDrag.lerp(V3_ZERO, frameLerp(CAM_RETURN_LERP, dt));
    this.camKick.multiplyScalar(Math.exp(-NUDGE_DECAY * dt));
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    this.shakeTime += dt;
    this.composeCamera();
  }

  /** Rest pose + drag-pan + directional kick + trauma shake (offset and roll). */
  private composeCamera(): void {
    const shake = this.trauma * this.trauma;
    const t = this.shakeTime * SHAKE_FREQ;
    this.camera.position.set(
      CAM_POS.x + this.camDrag.x + this.camKick.x + SHAKE_MAX_OFFSET * shake * noise(t, 0),
      CAM_POS.y + this.camDrag.y + this.camKick.y + SHAKE_MAX_OFFSET * shake * noise(t, 1),
      CAM_POS.z + this.camDrag.z + this.camKick.z,
    );
    this.camera.rotation.copy(this.baseRotation);
    this.camera.rotateZ(SHAKE_MAX_ROLL * shake * noise(t, 2));
  }

  /** Ball center height right now, arc hop included (for spawning fx). */
  private ballHeight(): number {
    return BALL_R + (this.arc ? arcHeight(this.arc, this.ballPos.y) : 0);
  }

  /** True while a goal's full-screen ink/paper swap is live (dither pass reads this). */
  isScreenInverted(): boolean {
    return this.invertFlash > 0;
  }

  // ---- HUD -----------------------------------------------------------------

  private syncHud(): void {
    this.scoreYouEl.textContent = String(this.scoreYou);
    this.scoreAiEl.textContent = String(this.scoreAi);
    // Prompt only when input is actually needed — auto-serve gaps stay quiet.
    this.promptEl.style.opacity = this.phase === "serving" && this.serveAt === null ? "1" : "0";

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
 * Paddle return: the lateral component scales linearly with the hit's x
 * offset from paddle center — dead-center returns straight, a full-edge
 * graze leaves MIN_VY_FRAC of the speed pointing at the opponent. Derived
 * from x alone: the y penetration depth at the detection frame varies with
 * frame rate and must not steer the ball (the legacy atan2-of-penetration
 * formula made the same hit return steep at 144Hz and shallow at 30Hz).
 * Speed stays exactly the given rally speed.
 */
function reflectOffPaddle(
  ballX: number,
  paddleX: number,
  towardY: 1 | -1,
  speed: number,
): THREE.Vector2 {
  const offset = clamp((ballX - paddleX) / HIT_HALF_X, -1, 1);
  const maxVxFrac = Math.sqrt(1 - MIN_VY_FRAC * MIN_VY_FRAC);
  const vx = offset * maxVxFrac * speed;
  const vy = towardY * Math.sqrt(speed * speed - vx * vx);
  return new THREE.Vector2(vx, vy);
}

/** Smooth ±1 pseudo-noise: two incommensurate sines, decorrelated per seed. */
function noise(t: number, seed: number): number {
  return 0.6 * Math.sin(t + seed * 17.31) + 0.4 * Math.sin(t * 2.3 + seed * 31.7);
}

/** Radial ink→transparent gradient — a soft blob the dither pass speckles. */
function softCircleTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unsupported");
  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, size * 0.06, half, half, half);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.55)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function arcProgress(arc: Arc, y: number): number {
  return clamp((y - arc.fromY) / (arc.toY - arc.fromY), 0, 1);
}

/** Parabola peaking at ARC_PEAK halfway through the hop. */
function arcHeight(arc: Arc, y: number): number {
  const p = arcProgress(arc, y);
  return 4 * ARC_PEAK * p * (1 - p);
}
