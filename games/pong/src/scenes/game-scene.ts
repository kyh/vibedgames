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
  BACKDROP_WALL,
  BALL_R,
  BG,
  BURST_CONFETTI,
  BURST_GOAL,
  BURST_PADDLE,
  BURST_WALL,
  CAM_BREATH_FREQ_X,
  CAM_BREATH_FREQ_Y,
  CAM_BREATH_FREQ_Z,
  CAM_BREATH_ROLL,
  CAM_BREATH_X,
  CAM_BREATH_Y,
  CAM_BREATH_Z,
  CAM_AIM_Y,
  CAM_DIP_MAX,
  CAM_DIP_RATE,
  CAM_FOV,
  CAM_PARALLAX_OMEGA,
  CAM_POS,
  CAM_RETURN_LERP,
  CAM_START_OFFSET_Y,
  CAM_STRAFE_X,
  CLICK_DRAG_TOLERANCE_PX,
  COMBO_MIN,
  COMBO_PEAK_HITS,
  CONFETTI_Z,
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
  NET_DASH,
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
  STREAK_LIFE_GAIN,
  STREAK_SIZE_GAIN,
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
  private camParallax = 0; // paddle-follow camera x offset (own field, smoothed)
  private camParallaxVel = 0; // carried velocity for the critically-damped spring
  private camDip = 0; // camera z duck, eased toward a target set by ball proximity
  private trauma = 0; // 0-1; shake amplitude = trauma²
  private shakeTime = 0;
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
  private comboEl = el("combo");
  private serveMeterEl = el("serve-meter");
  private serveMeterShown = false; // cached so we only touch classList on transitions

  constructor() {
    this.scene.background = new THREE.Color(BG);

    this.camera = new THREE.PerspectiveCamera(
      CAM_FOV,
      window.innerWidth / window.innerHeight,
      0.1,
      100,
    );
    // World-up = +z so every lookAt keeps the horizon level: as the orbit walks
    // the camera sideways it YAWS around the vertical axis (the table turns as if
    // you stepped to the side) instead of banking/rolling. Default up (0,1,0)
    // would tilt the table like a seesaw under the same orbit.
    this.camera.up.set(0, 0, 1);
    // composeCamera() fully drives the camera every frame (strafe + aim at the
    // enemy paddle + cosmetic offsets); this is just a sane initial pose.
    this.camera.position.set(CAM_POS.x, CAM_POS.y + this.camDrag.y, CAM_POS.z);
    this.camera.lookAt(0, CAM_AIM_Y, PADDLE_Z);

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

    // Dashed net across mid-court — the classic Pong read, one InstancedMesh of
    // ink quads (densest dither speckle). Inset so the end dashes clear the rails.
    const net = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(NET_DASH.w, NET_DASH.h),
      ink,
      NET_DASH.count,
    );
    const netSpan = COURT_W - NET_DASH.w;
    for (let i = 0; i < NET_DASH.count; i++) {
      const x = -netSpan / 2 + (netSpan * i) / (NET_DASH.count - 1);
      net.setMatrixAt(i, SCRATCH_M4.makeTranslation(x, 0, 0.004));
    }
    net.instanceMatrix.needsUpdate = true;
    this.scene.add(net);

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

    // Backdrop: a single tall UNLIT plane far behind the AI, leaning back to face
    // the tilted camera. Its faint vertical gradient (a touch below paper at the
    // horizon → clean paper toward the top) reads as a soft atmospheric horizon
    // and gives the orbit parallax a distant anchor to turn against. Unlit, so
    // color IS luminance — exactly what the dither pass quantizes.
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(BACKDROP_WALL.size.w, BACKDROP_WALL.size.h),
      new THREE.MeshBasicMaterial({
        map: verticalGradientTexture(BACKDROP_WALL.top, BACKDROP_WALL.bottom),
      }),
    );
    wall.position.set(BACKDROP_WALL.pos.x, BACKDROP_WALL.pos.y, BACKDROP_WALL.pos.z);
    wall.rotation.x = BACKDROP_WALL.tilt;
    this.scene.add(wall);

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
    this.comboEl.style.opacity = "0"; // the rally counter resets with the new rally
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
    this.showCombo();
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
    this.comboEl.style.opacity = "0"; // the rally is over
    const won = this.scoreYou >= WIN_SCORE || this.scoreAi >= WIN_SCORE;
    this.phase = won ? "won" : "serving";
    this.freeze = won ? HIT_STOP_WIN : HIT_STOP_GOAL;
    if (won) {
      sfx.win(this.scoreYou > this.scoreAi);
      // Confetti rain from above center — pure flair on the match climax.
      this.particles.burst({ x: 0, y: 0, z: CONFETTI_Z, ...BURST_CONFETTI });
    } else {
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
      // Speed streak: the trail thickens & lengthens with rally pace, so the
      // dither speckle density reads as velocity (0 at serve → 1 at the cap).
      const spd = clamp(
        (this.rallySpeed - RALLY_SPEED_BASE) / (RALLY_SPEED_MAX - RALLY_SPEED_BASE),
        0,
        1,
      );
      const ghostSize = TRAIL_SIZE * (1 + STREAK_SIZE_GAIN * spd);
      const ghostLife = TRAIL_LIFE * (1 + STREAK_LIFE_GAIN * spd);
      this.trailAcc += dt * TRAIL_RATE;
      const ghosts = Math.floor(this.trailAcc);
      this.trailAcc -= ghosts;
      for (let i = 0; i < ghosts; i++) {
        const back = (i + this.trailAcc) / TRAIL_RATE;
        this.particles.ghost(
          this.ballPos.x - this.ballVel.x * back,
          this.ballPos.y - this.ballVel.y * back,
          BALL_R + arcZ,
          ghostSize,
          ghostLife,
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
    // Ball-proximity dip: duck lower as the ball nears the player's side (0 on
    // the AI half → CAM_DIP_MAX at the player's goal), eased so it never jitters.
    const dipTarget = CAM_DIP_MAX * clamp(-this.ballPos.y / GOAL_Y, 0, 1);
    this.camDip += (dipTarget - this.camDip) * (1 - Math.exp(-CAM_DIP_RATE * dt));
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    this.shakeTime += dt;

    // Camera-strafe drive: a smoothed, normalized −1..1 tracking the paddle x,
    // feeding the lateral camera strafe in composeCamera. Critically damped, in
    // its OWN field — never camDrag (which self-centers every frame).
    const parallaxTarget = this.playerX / PADDLE_X_MAX;
    const damped = smoothDamp(
      this.camParallax,
      parallaxTarget,
      this.camParallaxVel,
      CAM_PARALLAX_OMEGA,
      dt,
    );
    this.camParallax = damped.pos;
    this.camParallaxVel = damped.vel;

    this.updateServeMeter();
    this.composeCamera();
  }

  /**
   * Drives the camera each frame: it STRAFES along the player's baseline with the
   * paddle and aims at the ENEMY paddle, so the view yaws to keep the opponent in
   * front of you as you move ("behind your paddle, facing the opponent"). Then
   * the cosmetic translational offsets (drag-pan, kick, idle breath, trauma
   * shake) are added AFTER the aim, so they translate the view without re-aiming,
   * plus a shake/breath roll. Offsets stay << shake so impacts mask them.
   */
  private composeCamera(): void {
    const shake = this.trauma * this.trauma;
    const t = this.shakeTime * SHAKE_FREQ;
    const e = this.elapsed;

    // Strafe with the paddle and aim at court center — the re-aim as you strafe
    // is the yaw. camDip ducks the camera lower as the ball nears the player's side.
    this.camera.position.set(this.camParallax * CAM_STRAFE_X, CAM_POS.y, CAM_POS.z - this.camDip);
    this.camera.lookAt(0, CAM_AIM_Y, PADDLE_Z);

    // Cosmetic offsets, applied after the aim so they translate without re-aiming.
    const breathX = CAM_BREATH_X * Math.sin(e * CAM_BREATH_FREQ_X);
    const breathY = CAM_BREATH_Y * Math.sin(e * CAM_BREATH_FREQ_Y + 1.7);
    const breathZ = CAM_BREATH_Z * Math.sin(e * CAM_BREATH_FREQ_Z + 0.5);
    this.camera.position.x +=
      this.camDrag.x + this.camKick.x + breathX + SHAKE_MAX_OFFSET * shake * noise(t, 0);
    this.camera.position.y +=
      this.camDrag.y + this.camKick.y + breathY + SHAKE_MAX_OFFSET * shake * noise(t, 1);
    this.camera.position.z += this.camDrag.z + this.camKick.z + breathZ;
    this.camera.rotateZ(
      SHAKE_MAX_ROLL * shake * noise(t, 2) +
        CAM_BREATH_ROLL * Math.sin(e * CAM_BREATH_FREQ_X * 0.5),
    );
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

  /** Surface the running rally length as an escalating "×N" once past MIN. */
  private showCombo(): void {
    if (this.rallyHits < COMBO_MIN) return;
    const tier = clamp(this.rallyHits / COMBO_PEAK_HITS, 0, 1);
    this.comboEl.textContent = `×${this.rallyHits}`;
    this.comboEl.style.setProperty("--combo-tier", tier.toFixed(3));
    this.comboEl.style.opacity = "1";
    this.comboEl.classList.remove("pop");
    void this.comboEl.offsetWidth; // restart the CSS pop
    this.comboEl.classList.add("pop");
  }

  /** Deplete the serve-countdown bar over the auto-serve dead air between points. */
  private updateServeMeter(): void {
    const active = this.phase === "serving" && this.serveAt !== null;
    if (active && this.serveAt !== null) {
      const left = Math.max(0, this.serveAt - this.elapsed);
      this.serveMeterEl.style.setProperty("--fill", `${(left / AUTO_SERVE_S) * 100}%`);
    }
    if (active !== this.serveMeterShown) {
      this.serveMeterEl.classList.toggle("on", active);
      this.serveMeterShown = active;
    }
  }
}

// ---- module helpers (pure) --------------------------------------------------

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const V3_ZERO = new THREE.Vector3(0, 0, 0);
const SCRATCH_M4 = new THREE.Matrix4();

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Convert a legacy per-frame (60fps) lerp factor into a dt-correct one. */
function frameLerp(perFrame: number, dt: number): number {
  return 1 - Math.pow(1 - perFrame, dt * LEGACY_FPS);
}

/**
 * One step of a critically-damped spring toward `target` (Game Programming
 * Gems 4). Frame-rate independent; `omega` is the natural frequency (rad/s) —
 * higher snaps faster. Returns the new position and its carried velocity.
 */
function smoothDamp(
  current: number,
  target: number,
  vel: number,
  omega: number,
  dt: number,
): { pos: number; vel: number } {
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (vel + omega * change) * dt;
  return { pos: target + (change + temp) * exp, vel: (vel - omega * temp) * exp };
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

/**
 * Vertical sRGB gradient (plane top → bottom) for the backdrop wall. Marked
 * sRGB so its grey values linearize the same way THREE.Color does — keeping the
 * dither remap (t = lum / lum(BG)) matched to the intended halftone density.
 */
function verticalGradientTexture(topHex: number, bottomHex: number): THREE.CanvasTexture {
  const w = 4;
  const h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unsupported");
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, cssHex(topHex));
  grad.addColorStop(1, cssHex(bottomHex));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** "#rrggbb" for a 24-bit hex color number. */
function cssHex(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

function arcProgress(arc: Arc, y: number): number {
  return clamp((y - arc.fromY) / (arc.toY - arc.fromY), 0, 1);
}

/** Parabola peaking at ARC_PEAK halfway through the hop. */
function arcHeight(arc: Arc, y: number): number {
  const p = arcProgress(arc, y);
  return 4 * ARC_PEAK * p * (1 - p);
}
