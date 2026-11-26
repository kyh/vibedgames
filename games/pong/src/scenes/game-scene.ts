import * as THREE from "three";
import { notifyGameStarted } from "@repo/embed";
import { PhysicalGamepad } from "@vibedgames/gamepad";
import { lerp } from "@vibedgames/multiplayer";

import { ParticlePool } from "../fx/particles";
import { sfx } from "../fx/sfx";
import { RingPool } from "../fx/shock-rings";
import { MatchControl } from "../net/match-control";
import type { Rollback } from "../net/rollback";
import { Hud } from "../render/hud";
import {
  ARC_PEAK,
  AUTO_SERVE_S,
  BACKDROP_WALL,
  BALL_EASE_S,
  BALL_R,
  BALL_SNAP,
  BG,
  BURST_CONFETTI,
  BURST_GOAL,
  BURST_PADDLE,
  BURST_WALL,
  CAM_AIM_Y,
  CAM_BREATH_FREQ_X,
  CAM_BREATH_FREQ_Y,
  CAM_BREATH_FREQ_Z,
  CAM_BREATH_ROLL,
  CAM_BREATH_X,
  CAM_BREATH_Y,
  CAM_BREATH_Z,
  CAM_DIP_MAX,
  CAM_DIP_RATE,
  CAM_FOV,
  CAM_MIN_LANDSCAPE_ASPECT,
  CAM_PARALLAX_OMEGA,
  CAM_POS,
  CAM_RETURN_LERP,
  CAM_START_OFFSET_Y,
  CAM_STRAFE_X,
  CLICK_DRAG_TOLERANCE_PX,
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
  INK,
  INVERT_FLASH_S,
  LEGACY_FPS,
  MP_ROOM,
  NET_DASH,
  NUDGE_DECAY,
  NUDGE_SCALE,
  PAD_DEAD_ZONE,
  PAD_LERP,
  PADDLE_RING_R,
  PADDLE_TUBE_R,
  PADDLE_X_MAX,
  PADDLE_Y,
  PADDLE_Z,
  PULSE_DECAY,
  PULSE_SCALE,
  RALLY_SPEED_BASE,
  RALLY_SPEED_MAX,
  RING_GOAL,
  RING_PADDLE,
  SERVE_PULSE_FREQ,
  SERVE_PULSE_SCALE,
  SHADOW_ARC_GROW,
  SHADOW_MAX_OPACITY,
  SHAKE_FREQ,
  SHAKE_MAX_OFFSET,
  SHAKE_MAX_ROLL,
  SQUASH,
  SQUASH_RECOVER,
  STREAK_LIFE_GAIN,
  STREAK_SIZE_GAIN,
  TICK_S,
  TRAIL_LIFE,
  TRAIL_RATE,
  TRAIL_SIZE,
  TRAUMA_DECAY,
  TRAUMA_GOAL,
  TRAUMA_PADDLE,
  TRAUMA_WALL,
  WIN_SCORE,
} from "../shared/constants";
import { chargeHits } from "../shared/contact-shot";
import type { ContactKind } from "../shared/contact-shot";
import { bump, paddleStep } from "../shared/input";
import { newMatch, paddleOf, serveNow, simChecksum } from "../shared/sim";
import type { Arc, HitEvent, SimEvent, SimState, Slot } from "../shared/sim";
import { SPIN_TICKS } from "../shared/spin";

const ROOM = (import.meta.env.DEV && new URLSearchParams(location.search).get("room")) || MP_ROOM;

const BALL_JUMP = 2;
const SCAN_TICKS = 60;

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const V3_ZERO = new THREE.Vector3(0, 0, 0);
const SCRATCH_M4 = new THREE.Matrix4();

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const fovForAspect = (aspect: number) => {
  if (aspect >= CAM_MIN_LANDSCAPE_ASPECT) {
    return CAM_FOV;
  }

  const tanHalfH = Math.tan(THREE.MathUtils.degToRad(CAM_FOV / 2)) * CAM_MIN_LANDSCAPE_ASPECT;

  return THREE.MathUtils.radToDeg(2 * Math.atan(tanHalfH / aspect));
};

const frameLerp = (perFrame: number, dt: number) => 1 - (1 - perFrame) ** (dt * LEGACY_FPS);

const DAMP_OUT = { pos: 0, vel: 0 };

const smoothDamp = (current: number, target: number, vel: number, omega: number, dt: number) => {
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (vel + omega * change) * dt;
  DAMP_OUT.pos = target + (change + temp) * exp;
  DAMP_OUT.vel = (vel - omega * temp) * exp;

  return DAMP_OUT;
};

const flashMaterial = () =>
  new THREE.MeshBasicMaterial({
    color: INK,
    depthWrite: false,
    opacity: 0,
    transparent: true,
  });

const noise = (t: number, seed: number) =>
  0.6 * Math.sin(t + seed * 17.31) + 0.4 * Math.sin(t * 2.3 + seed * 31.7);

const softCircleTexture = () => {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("2d canvas unsupported");
  }

  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, size * 0.06, half, half, half);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.55)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  return new THREE.CanvasTexture(canvas);
};

const cssHex = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;

const verticalGradientTexture = (topHex: number, bottomHex: number) => {
  const w = 4;
  const h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("2d canvas unsupported");
  }

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, cssHex(topHex));
  grad.addColorStop(1, cssHex(bottomHex));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;

  return tex;
};

const arcProgress = (arc: Arc, y: number) => clamp((y - arc.fromY) / (arc.toY - arc.fromY), 0, 1);

const arcHeight = (arc: Arc, y: number) => {
  const p = arcProgress(arc, y);

  return 4 * ARC_PEAK * p * (1 - p);
};

const pointCallout = (won: boolean, iScored: boolean) => {
  if (won) {
    return "";
  }

  return iScored ? "YOU SCORE" : "RIVAL SCORES";
};

const otherSlot: (slot: Slot) => Slot = (slot) => (slot === 0 ? 1 : 0);

interface Sample {
  rival: number;
  x: number;
  y: number;
}

const sampleAt = (engine: Rollback, at: number, rival: Slot) => {
  const tick = Math.floor(at);
  const now = engine.stateAt(tick);

  if (now === undefined) {
    return;
  }

  const before = engine.stateAt(tick - 1) ?? now;
  const k = at - tick;

  const jumped =
    Math.abs(now.ball.x - before.ball.x) + Math.abs(now.ball.y - before.ball.y) > BALL_JUMP;

  const from = jumped ? now : before;

  return {
    rival: lerp(paddleOf(before, rival).x, paddleOf(now, rival).x, k),
    x: lerp(from.ball.x, now.ball.x, k),
    y: lerp(from.ball.y, now.ball.y, k),
  };
};

const ballTick = (horizon: number, rival: number, progress: number) =>
  horizon - progress * Math.max(0, horizon - rival);

const awaitsConfirmation = (event: SimEvent, state: SimState, mine: Slot) => {
  if (event.kind !== "point") {
    return false;
  }

  const defender = otherSlot(event.scorer);

  return defender !== mine && paddleOf(state, defender).human;
};

export class GameScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  /** Public for the two-client harness, which reads the match through it. */
  readonly control: MatchControl;
  /** Public for the two-client harness, which aims from the ball it shows. */
  shown: SimState;
  private settled: SimState;
  private shownAt = 0;
  private horizonAt = 0;
  private rivalAt = 0;
  private shownEngine: Rollback | null = null;
  private slot: Slot = 0;
  private readonly fired = new Map<string, number>();
  private firedScope = "";
  private scanFrom = 0;
  private readonly simBall = new THREE.Vector2();
  private readonly ballEase = new THREE.Vector2();
  private readonly drawnBall = new THREE.Vector2();
  private rivalX = 0;
  private returns = 0;
  private powerShots = 0;
  private spinShots = 0;
  private frame = 0;
  private testSeed = 1 + Math.floor(Math.random() * 1_000_000);

  /** Public for the two-client harness, which steers the paddle directly. */
  localX = 0;
  private presses = 0;
  private cancels = 0;

  private pause: "none" | "input" | "frozen" = "none";

  private elapsed = 0;
  private playerPulse = 0;
  private aiPulse = 0;
  private readonly camKick = new THREE.Vector3();
  private camParallax = 0;
  private camParallaxVel = 0;
  private camDip = 0;
  private trauma = 0;
  private shakeTime = 0;
  private invertFlash = 0;
  private flashNear = 0;
  private flashFar = 0;
  private trailAcc = 0;
  private readonly particles: ParticlePool;
  private readonly rings: RingPool;
  private readonly motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  private reducedMotion = this.motionQuery.matches;
  private shotUntil = 0;
  private pointUntil = 0;

  private readonly playerRing: THREE.Mesh;
  private readonly aiRing: THREE.Mesh;
  private readonly ball: THREE.Mesh;
  private readonly shadowMat: THREE.MeshBasicMaterial;
  private readonly shadow: THREE.Mesh;
  private readonly flashNearMat: THREE.MeshBasicMaterial;
  private readonly flashFarMat: THREE.MeshBasicMaterial;

  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly tablePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly planeHit = new THREE.Vector3();

  private handX: number | null = null;
  private handSeenAt = 0;
  private lastHandX: number | null = null;

  private readonly pad = new PhysicalGamepad();

  private dragging = false;
  private readonly lastPointer = { x: 0, y: 0 };
  private readonly downAt = { x: 0, y: 0 };
  private readonly camDrag = new THREE.Vector3(0, CAM_START_OFFSET_Y, 0);

  private readonly hud = new Hud(() => this.bannerAction());

  constructor() {
    this.control = new MatchControl(ROOM, this.localInput());
    this.shown = this.control.driver.engine.confirmed;
    this.settled = this.shown;

    this.scene.background = new THREE.Color(BG);

    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(fovForAspect(aspect), aspect, 0.1, 100);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(CAM_POS.x, CAM_POS.y + this.camDrag.y, CAM_POS.z);
    this.camera.lookAt(0, CAM_AIM_Y, PADDLE_Z);

    const key = new THREE.DirectionalLight(0xff_ff_ff, 2);
    key.position.set(-4, -8, 9);
    this.scene.add(key);

    const ink = new THREE.MeshBasicMaterial({ color: INK });
    const tablePlane = new THREE.PlaneGeometry(COURT_W, COURT_D);

    const table = new THREE.LineSegments(
      new THREE.EdgesGeometry(tablePlane),
      new THREE.LineBasicMaterial({ color: INK }),
    );

    tablePlane.dispose();
    this.scene.add(table);

    const net = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(NET_DASH.w, NET_DASH.h),
      ink,
      NET_DASH.count,
    );

    const netSpan = COURT_W - NET_DASH.w;

    for (let i = 0; i < NET_DASH.count; i += 1) {
      const x = -netSpan / 2 + (netSpan * i) / (NET_DASH.count - 1);
      net.setMatrixAt(i, SCRATCH_M4.makeTranslation(x, 0, 0.004));
    }

    net.instanceMatrix.needsUpdate = true;
    this.scene.add(net);

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

    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(BACKDROP_WALL.size.w, BACKDROP_WALL.size.h),
      new THREE.MeshBasicMaterial({
        map: verticalGradientTexture(BACKDROP_WALL.top, BACKDROP_WALL.bottom),
      }),
    );

    wall.position.set(BACKDROP_WALL.pos.x, BACKDROP_WALL.pos.y, BACKDROP_WALL.pos.z);
    wall.rotation.x = BACKDROP_WALL.tilt;
    this.scene.add(wall);

    const ringGeo = new THREE.TorusGeometry(PADDLE_RING_R, PADDLE_TUBE_R, 16, 100);
    this.playerRing = new THREE.Mesh(ringGeo, ink);
    this.playerRing.rotation.x = Math.PI / 2;
    this.playerRing.position.set(0, -PADDLE_Y, PADDLE_Z);
    this.aiRing = new THREE.Mesh(ringGeo, ink);
    this.aiRing.rotation.x = Math.PI / 2;
    this.aiRing.position.set(0, PADDLE_Y, PADDLE_Z);
    this.scene.add(this.playerRing, this.aiRing);

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 16, 16),
      new THREE.MeshPhongMaterial({ color: 0x11_11_11, shininess: 40, specular: 0xbb_bb_bb }),
    );
    this.ball.position.z = BALL_R;
    this.scene.add(this.ball);

    this.shadowMat = new THREE.MeshBasicMaterial({
      depthWrite: false,
      map: softCircleTexture(),
      opacity: SHADOW_MAX_OPACITY,
      transparent: true,
    });
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(BALL_R * 5, BALL_R * 5), this.shadowMat);
    this.shadow.position.z = 0.01;
    this.scene.add(this.shadow);

    this.particles = new ParticlePool(this.scene);
    this.rings = new RingPool(this.scene);

    window.addEventListener("blur", this.onBlur);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    this.motionQuery.addEventListener("change", (e) => this.setReducedMotion(e.matches));
    this.setReducedMotion(this.reducedMotion);
    this.syncHud();
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.fov = fovForAspect(aspect);
    this.camera.updateProjectionMatrix();
  }

  private get flip() {
    return this.slot === 0 ? 1 : -1;
  }

  /** A rival shares this match's clock (so the AI stands down and the match
   *  cannot be paused). */
  hasLiveOpponent() {
    return this.control.ticking;
  }

  private localInput() {
    return { c: this.presses, k: this.cancels, x: paddleStep(this.localX) };
  }

  /** Wrapper asked us to pause. With a rival on the room's clock the match
   *  keeps running behind the overlay and only our input is suspended. A
   *  queued power shot is released either way. */
  requestPause() {
    this.pause = this.control.ticking ? "input" : "frozen";
    this.dragging = false;
    this.handX = null;
    this.lastHandX = null;
    this.cancelMyPower();
  }

  requestResume() {
    this.pause = "none";
    this.pad.update();
  }

  private readonly onBlur = () => {
    this.dragging = false;
    this.cancelMyPower();
  };

  /** Wrist landmark x ∈ [0,1] from the webcam tracker (also the DEV hook). */
  handleHandPosition(x: number) {
    if (this.pause !== "none" || !Number.isFinite(x) || x < 0 || x > 1) {
      return;
    }

    this.handX = x;
    this.handSeenAt = performance.now();
  }

  /** Fresh fist edge: arm a charged return, or serve/rematch between rallies. */
  handleGestureConfirm() {
    this.confirm();
  }

  private currentHandX() {
    if (this.handX === null) {
      return null;
    }

    return performance.now() - this.handSeenAt < HAND_TIMEOUT_MS ? this.handX : null;
  }

  private readonly onPointerMove = (e: PointerEvent) => {
    if (this.pause !== "none") {
      return;
    }

    if (this.dragging) {
      if (e.buttons === 0) {
        this.dragging = false;
      } else {
        this.camDrag.x -= (e.clientX - this.lastPointer.x) * DRAG_PAN_SCALE;
        this.camDrag.y += (e.clientY - this.lastPointer.y) * DRAG_PAN_SCALE;
        this.lastPointer.x = e.clientX;
        this.lastPointer.y = e.clientY;

        return;
      }
    }

    if (this.currentHandX() !== null || this.padSteerX() !== null) {
      return;
    }

    const x = this.pointerToTableX(e);

    if (x !== null) {
      this.localX = x;
    }
  };

  private readonly onPointerDown = (e: PointerEvent) => {
    if (this.pause !== "none") {
      return;
    }

    if (e.pointerType === "mouse") {
      this.dragging = true;
      this.lastPointer.x = e.clientX;
      this.lastPointer.y = e.clientY;
      this.downAt.x = e.clientX;
      this.downAt.y = e.clientY;

      return;
    }

    this.confirm();
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (this.pause === "none" && this.dragging && e.pointerType === "mouse") {
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);

      if (moved < CLICK_DRAG_TOLERANCE_PX) {
        this.confirm();
      }
    }

    this.dragging = false;
  };

  private pointerToTableX(e: PointerEvent) {
    this.ndc.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.tablePlane, this.planeHit);

    return hit ? clamp(this.flip * hit.x, -PADDLE_X_MAX, PADDLE_X_MAX) : null;
  }

  private confirm() {
    if (this.pause !== "none") {
      return;
    }

    if (this.control.session.connectionStatus === "connecting") {
      this.playSolo();
    }

    this.presses = bump(this.presses);
  }

  private bannerAction() {
    if (this.pause === "none" && this.control.session.connectionStatus === "reconnecting") {
      this.playSolo();
    }

    this.confirm();
  }

  private cancelMyPower() {
    if (this.myCharge.kind === "armed") {
      this.cancels = bump(this.cancels);
    }
  }

  private playSolo(base?: SimState) {
    this.control.goOffline(this.localInput(), base);
  }

  private applyPaddleInput(dt: number) {
    if (this.pause !== "none") {
      return;
    }

    const { flip } = this;

    const hand = this.currentHandX();

    if (hand !== null) {
      const targetX =
        flip * clamp((1 - hand) * HAND_RANGE - PADDLE_X_MAX, -PADDLE_X_MAX, PADDLE_X_MAX);

      const wristSpeed = this.lastHandX === null ? 0 : Math.abs(hand - this.lastHandX);
      this.lastHandX = hand;
      const perFrame = clamp(HAND_LERP_BASE + wristSpeed * HAND_LERP_ACCEL, 0, 1);
      this.localX += (targetX - this.localX) * frameLerp(perFrame, dt);

      return;
    }

    if (this.lastHandX !== null) {
      this.cancelMyPower();
    }

    this.lastHandX = null;

    const padX = this.padSteerX();

    if (padX !== null) {
      const targetX = flip * padX * PADDLE_X_MAX;
      this.localX += (targetX - this.localX) * frameLerp(PAD_LERP, dt);
    }
  }

  private padSteerX() {
    const { dx } = this.pad.getStick();

    if (Math.abs(dx) <= PAD_DEAD_ZONE) {
      return null;
    }

    const norm = (Math.abs(dx) - PAD_DEAD_ZONE) / (1 - PAD_DEAD_ZONE);

    return Math.sign(dx) * Math.min(1, norm);
  }

  update(dt: number) {
    if (this.pause === "frozen" && this.control.ticking) {
      this.pause = "input";
    }

    if (this.pause === "frozen") {
      this.control.frame(this.localInput(), dt * 1000, false);

      return;
    }

    this.frame += 1;
    this.elapsed += dt;
    this.expireCallouts();
    this.invertFlash = Math.max(0, this.invertFlash - dt);

    this.pad.update();

    if (this.pad.justPressed("a")) {
      this.confirm();
    }

    this.applyPaddleInput(dt);

    const horizon = this.control.frame(this.localInput(), dt * 1000, true);
    this.present(horizon, dt);
    this.playEvents();
    this.syncHud();

    if (this.shown.freeze > 0) {
      this.shakeTime += dt;
      this.placePaddles();
      this.composeCamera();
    } else {
      this.updateVisuals(dt);
    }
  }

  private present(horizon: number, dt: number) {
    const { driver } = this.control;
    const { engine } = driver;
    const rival = otherSlot(driver.mySlot);

    if (driver.mySlot !== this.slot) {
      this.slot = driver.mySlot;
      this.localX = -this.localX;
    }

    const fresh = engine !== this.shownEngine;

    if (fresh) {
      this.shownEngine = engine;
      this.ballEase.set(0, 0);
      this.scanFrom = engine.confirmedTick;
    } else {
      const again = sampleAt(engine, this.shownAt, rival);

      if (again !== undefined) {
        this.absorbCorrection(again);
      }
    }

    this.horizonAt = horizon;
    this.rivalAt = driver.kind === "tick" ? driver.rivalTick() : horizon;
    const target = ballTick(horizon, this.rivalAt, this.courtProgress());

    const at = clamp(
      fresh ? target : Math.max(this.shownAt, target),
      engine.confirmedTick - SCAN_TICKS,
      engine.predictedTick + 0.999,
    );

    this.shownAt = at;
    this.control.show(Math.floor(at));
    this.shown = engine.stateAt(Math.floor(at)) ?? engine.confirmed;

    const now = sampleAt(engine, at, rival) ?? {
      rival: paddleOf(this.shown, rival).x,
      x: this.shown.ball.x,
      y: this.shown.ball.y,
    };

    this.simBall.set(now.x, now.y);
    this.ballEase.multiplyScalar(Math.exp(-dt / BALL_EASE_S));
    this.drawnBall.set(now.x + this.ballEase.x, now.y + this.ballEase.y);
    this.rivalX = (driver.kind === "tick" ? driver.rival.sample() : undefined) ?? now.rival;
  }

  private courtProgress() {
    const towardRival = this.slot === 0 ? this.drawnBall.y : -this.drawnBall.y;

    return clamp((towardRival + PADDLE_Y) / (2 * PADDLE_Y), 0, 1);
  }

  private absorbCorrection(again: Sample) {
    const dx = this.simBall.x - again.x;
    const dy = this.simBall.y - again.y;

    if (Math.hypot(dx, dy) < BALL_SNAP) {
      this.ballEase.x += dx;
      this.ballEase.y += dy;
    } else {
      this.ballEase.set(0, 0);
    }
  }

  private playEvents() {
    const { driver, scope } = this.control;
    const { engine } = driver;

    if (scope !== this.firedScope) {
      this.fired.clear();
      this.firedScope = scope;
    }

    const shownTick = Math.floor(this.shownAt);
    const confirmed = engine.confirmedTick;
    let pending: number | null = null;

    for (let t = Math.max(this.scanFrom, shownTick - SCAN_TICKS); t <= shownTick; t += 1) {
      const state = engine.stateAt(t);

      if (state === undefined) {
        continue;
      }

      for (const event of state.events) {
        if (this.fired.has(event.key)) {
          continue;
        }

        if (t > confirmed && awaitsConfirmation(event, state, this.slot)) {
          pending ??= t;
          continue;
        }

        this.fired.set(event.key, t);
        this.play(event);
      }
    }

    this.scanFrom = Math.min(confirmed, shownTick) + 1;
    this.settled = pending === null ? this.shown : (engine.stateAt(pending - 1) ?? this.shown);

    if (this.fired.size > 512) {
      for (const [key, tick] of this.fired) {
        if (tick < confirmed - 10 * SCAN_TICKS) {
          this.fired.delete(key);
        }
      }
    }
  }

  private play(event: SimEvent) {
    switch (event.kind) {
      case "serve": {
        sfx.serve();
        notifyGameStarted();
        this.hud.setPoint("");
        this.pointUntil = 0;
        this.hud.hideCombo();
        break;
      }

      case "wall": {
        this.wallFx(event.x, event.y);
        break;
      }

      case "land": {
        this.squashBall("z");
        break;
      }

      case "hit": {
        this.hitFx(event);
        break;
      }

      case "point": {
        this.pointFx(event.scorer === this.slot, event.x, event.y, event.won);
        break;
      }

      default: {
        break;
      }
    }
  }

  private expireCallouts() {
    if (this.shotUntil > 0 && this.elapsed >= this.shotUntil) {
      this.shotUntil = 0;
      this.hud.hideShot();
    }

    if (this.pointUntil > 0 && this.elapsed >= this.pointUntil) {
      this.pointUntil = 0;
      this.hud.setPoint("");
    }
  }

  private hitFx(hit: HitEvent) {
    const { flip } = this;
    const sx = flip * hit.x;
    const sy = flip * hit.y;
    const mine = hit.slot === this.slot;

    if (mine) {
      this.returns += 1;
    }

    if (hit.powered) {
      this.powerShots += 1;
    }

    if (hit.spin !== 0) {
      this.spinShots += 1;
    }

    this.trauma = Math.min(1, this.trauma + TRAUMA_PADDLE);

    if (mine) {
      this.playerPulse = 1;
    } else {
      this.aiPulse = 1;
    }

    this.squashBall("y");
    this.camKick.set(hit.vx * flip * NUDGE_SCALE, hit.vy * flip * NUDGE_SCALE, 0);
    this.particles.burst({
      dirX: hit.vx * flip,
      dirY: hit.vy * flip,
      x: sx,
      y: sy,
      z: this.ballHeight(),
      ...BURST_PADDLE,
    });
    this.rings.spawn({ x: sx, y: mine ? -PADDLE_Y : PADDLE_Y, ...RING_PADDLE });
    this.hud.showCombo(hit.hits);

    if (hit.shot !== "flat" || hit.powered) {
      this.showShot(hit.shot, mine, hit.powered);
      this.rings.spawn({
        from: 0.18,
        life: 0.18,
        opacity: 0.85,
        to: hit.powered ? 1.1 : 0.8,
        x: sx,
        y: sy,
      });
      this.particles.burst({
        dirX: hit.spin * flip,
        dirY: hit.spin === 0 ? Math.sign(hit.vy) * flip : 0,
        x: sx,
        y: sy,
        z: this.ballHeight(),
        ...BURST_PADDLE,
        count: hit.powered ? 8 : 5,
        life: 0.2,
        size: 0.045,
        spread: 0.35,
      });
    }

    sfx.paddleHit(hit.hits);
  }

  private pointFx(iScored: boolean, cx: number, cy: number, won: boolean) {
    const { flip } = this;
    const sx = flip * cx;
    const sy = flip * cy;
    this.hud.popScore(iScored ? "you" : "ai");

    if (iScored) {
      this.flashFar = 1;
    } else {
      this.flashNear = 1;
    }

    this.invertFlash = this.reducedMotion ? 0 : INVERT_FLASH_S;
    this.trauma = Math.min(1, this.trauma + TRAUMA_GOAL);
    this.particles.burst({ dirY: -Math.sign(sy), x: sx, y: sy, z: BALL_R, ...BURST_GOAL });
    this.rings.spawn({ x: sx, y: sy, ...RING_GOAL });
    this.hud.hideCombo();
    this.hud.hideShot();
    this.shotUntil = 0;

    this.hud.setPoint(pointCallout(won, iScored));
    this.pointUntil = won ? 0 : this.elapsed + AUTO_SERVE_S;

    if (won) {
      sfx.win(iScored);

      if (!this.reducedMotion) {
        this.particles.burst({ x: 0, y: 0, z: CONFETTI_Z, ...BURST_CONFETTI });
      }
    } else {
      sfx.score(iScored);
    }
  }

  private wallFx(cx: number, cy: number) {
    const { flip } = this;
    this.squashBall("x");
    this.trauma = Math.min(1, this.trauma + TRAUMA_WALL);
    this.particles.burst({
      dirX: -Math.sign(cx) * flip,
      x: flip * cx,
      y: flip * cy,
      z: this.ballHeight(),
      ...BURST_WALL,
    });
    sfx.wall();
  }

  private squashBall(axis: "x" | "y" | "z") {
    const s = this.ball.scale;
    s.set(1 + SQUASH / 2, 1 + SQUASH / 2, 1 + SQUASH / 2);
    s[axis] = 1 - SQUASH;
  }

  private placePaddles() {
    const { flip } = this;
    this.playerRing.position.x = flip * this.localX;
    this.aiRing.position.x = flip * this.rivalX;
  }

  private updateVisuals(dt: number) {
    const { flip, shown } = this;
    this.placePaddles();
    this.playerPulse *= Math.exp(-PULSE_DECAY * dt);
    this.aiPulse *= Math.exp(-PULSE_DECAY * dt);
    this.playerRing.scale.setScalar(
      1 + PULSE_SCALE * this.playerPulse * (this.reducedMotion ? 0.3 : 1),
    );
    this.aiRing.scale.setScalar(1 + PULSE_SCALE * this.aiPulse * (this.reducedMotion ? 0.3 : 1));

    const { x: ballX, y: ballY } = this.drawnBall;
    const arcZ = shown.arc ? arcHeight(shown.arc, ballY) * shown.lift : 0;
    this.ball.position.set(flip * ballX, flip * ballY, BALL_R + arcZ);
    this.ball.scale.lerp(UNIT_SCALE, 1 - Math.exp(-SQUASH_RECOVER * dt));

    if (shown.phase === "serving" && !this.reducedMotion) {
      this.ball.scale.setScalar(1 + SERVE_PULSE_SCALE * Math.sin(this.elapsed * SERVE_PULSE_FREQ));
    }

    if (shown.phase === "rally" && !shown.parked) {
      const spd = clamp(
        (shown.speed - RALLY_SPEED_BASE) / (RALLY_SPEED_MAX - RALLY_SPEED_BASE),
        0,
        1,
      );

      const ghostSize = TRAIL_SIZE * (1 + STREAK_SIZE_GAIN * spd);
      const ghostLife = TRAIL_LIFE * (1 + STREAK_LIFE_GAIN * spd) * (this.reducedMotion ? 0.5 : 1);
      this.trailAcc += dt * TRAIL_RATE;
      const ghosts = Math.floor(this.trailAcc);
      this.trailAcc -= ghosts;
      const { spin, vx, vy } = shown.ball;

      for (let i = 0; i < ghosts; i += 1) {
        const back = (i + this.trailAcc) / TRAIL_RATE;
        this.particles.ghost(
          flip * (ballX - vx * back),
          flip * (ballY - vy * back),
          BALL_R + arcZ,
          ghostSize,
          ghostLife,
        );

        if (spin !== 0 && !this.reducedMotion && i % 2 === 0) {
          this.particles.ghost(
            flip * (ballX - vx * back + Math.sign(spin) * 0.22),
            flip * (ballY - vy * back),
            BALL_R + arcZ,
            ghostSize * 0.32,
            ghostLife * 0.8,
          );
        }
      }
    }

    this.particles.update(dt);
    this.rings.update(dt);

    this.shadow.position.set(flip * ballX, flip * ballY, 0.01);
    this.shadow.scale.setScalar(1 + (arcZ / ARC_PEAK) * SHADOW_ARC_GROW);
    this.shadowMat.opacity = SHADOW_MAX_OPACITY * Math.max(0, 1 - arcZ / ARC_PEAK);

    this.flashNear *= Math.exp(-GOAL_FLASH_DECAY * dt);
    this.flashFar *= Math.exp(-GOAL_FLASH_DECAY * dt);
    this.flashNearMat.opacity = 0.85 * this.flashNear;
    this.flashFarMat.opacity = 0.85 * this.flashFar;

    if (!this.dragging) {
      this.camDrag.lerp(V3_ZERO, frameLerp(CAM_RETURN_LERP, dt));
    }

    this.camKick.multiplyScalar(Math.exp(-NUDGE_DECAY * dt));
    const dipTarget = CAM_DIP_MAX * clamp(-(flip * ballY) / GOAL_Y, 0, 1);
    this.camDip += (dipTarget - this.camDip) * (1 - Math.exp(-CAM_DIP_RATE * dt));
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    this.shakeTime += dt;

    const parallaxTarget = (flip * this.localX) / PADDLE_X_MAX;

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

  private composeCamera() {
    if (this.reducedMotion) {
      this.camera.position.set(this.camDrag.x, CAM_POS.y + this.camDrag.y, CAM_POS.z);
      this.camera.lookAt(0, CAM_AIM_Y, PADDLE_Z);

      return;
    }

    const shake = this.trauma * this.trauma;
    const t = this.shakeTime * SHAKE_FREQ;
    const e = this.elapsed;

    this.camera.position.set(this.camParallax * CAM_STRAFE_X, CAM_POS.y, CAM_POS.z - this.camDip);
    this.camera.lookAt(0, CAM_AIM_Y, PADDLE_Z);

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

  private ballHeight() {
    const { arc, lift } = this.shown;

    return BALL_R + (arc ? arcHeight(arc, this.drawnBall.y) * lift : 0);
  }

  /** True while a goal's full-screen ink/paper swap is live (dither pass reads this). */
  isScreenInverted() {
    return !this.reducedMotion && this.invertFlash > 0;
  }

  setReducedMotion(enabled: boolean) {
    this.reducedMotion = enabled;
    document.documentElement.classList.toggle("reduced-motion", enabled);

    if (enabled) {
      this.invertFlash = 0;
      this.camDrag.set(0, 0, 0);
      this.camKick.set(0, 0, 0);
      this.trauma = 0;
    }

    this.composeCamera();
  }

  private get myCharge() {
    const { engine } = this.control.driver;
    const ahead = engine.stateAt(Math.min(Math.floor(this.horizonAt), engine.predictedTick));
    const { charge } = paddleOf(ahead ?? this.shown, this.slot);
    const drawn = paddleOf(this.shown, this.slot).charge;

    return charge.kind === "ready" && drawn.kind === "armed" ? drawn : charge;
  }

  /** Plain telemetry for the playtest contract, in this player's view frame;
   *  no engine objects escape. */
  diagnostics() {
    const { flip, settled, shown, slot } = this;
    const { ball } = shown;
    const { engine } = this.control.driver;
    const charge = this.myCharge;

    return {
      ball: {
        spin: ball.spin,
        spinLeft: ball.spin === 0 ? 0 : (SPIN_TICKS - ball.spinAge) * TICK_S,
        vx: flip * ball.vx,
        vy: flip * ball.vy,
        x: flip * this.drawnBall.x,
        y: flip * this.drawnBall.y,
      },
      charge: {
        armed: charge.kind === "armed",
        hits: chargeHits(charge),
        ready: charge.kind === "ready",
        rivalHits: chargeHits(paddleOf(shown, otherSlot(slot)).charge),
      },
      complete: settled.phase === "won",
      entities: 3,
      frame: this.frame,
      handActive: this.currentHandX() !== null,
      longestRally: settled.longest,
      net: {
        clock: this.control.driver.kind,
        confirmed: engine.confirmedTick,
        mispredicted: engine.stats.mispredicted,
        resimulated: engine.stats.resimulated,
        slot,
      },
      opponent: { x: flip * this.rivalX },
      opponentScore: slot === 0 ? settled.scoreB : settled.scoreA,
      paused: this.pause === "frozen",
      phase: settled.phase,
      player: {
        x: flip * this.localX,
        y: -PADDLE_Y,
      },
      points: slot === 0 ? settled.scoreA : settled.scoreB,
      powerShots: this.powerShots,
      rallyHits: shown.hits,
      reducedMotion: this.reducedMotion,
      score: (slot === 0 ? settled.scoreA : settled.scoreB) * 10 + this.returns,
      spinShots: this.spinShots,
    };
  }

  /** DEV / two-client harness: the match this client follows, and a
   *  fingerprint of its state at a tick (undefined once out of reach). */
  debugMatch(at?: number) {
    const { driver } = this.control;
    const { engine } = driver;
    const tick = at ?? engine.confirmedTick;
    const state = tick <= engine.confirmedTick ? engine.stateAt(tick) : undefined;

    return {
      checksum: state === undefined ? undefined : simChecksum(state),
      clock: driver.kind,
      confirmed: engine.confirmedTick,
      record: driver.kind === "tick" ? driver.record.id : null,
      slot: driver.mySlot,
      stats: { ...engine.stats },
      tick,
    };
  }

  /** Dev/test-only callers use this to restart a reproducible solo run. */
  seed(seed: number) {
    this.testSeed = seed;
    this.setTestState("active-play");
  }

  setTestState(name: string) {
    if (name !== "active-play" && name !== "match-point" && name !== "fail") {
      throw new Error(`Unknown Pong playtest state: ${name}`);
    }

    const fail = name === "fail";

    const base = newMatch({
      autoServe: false,
      scoreA: name === "match-point" ? WIN_SCORE - 1 : 0,
      scoreB: fail ? WIN_SCORE : 0,
      seed: this.testSeed,
      tick: 0,
    });

    base.a.c = this.presses;
    base.a.k = this.cancels;

    if (!fail) {
      serveNow(base);
    }

    this.pause = "none";
    this.localX = 0;
    this.handX = null;
    this.lastHandX = null;
    this.spinShots = 0;
    this.powerShots = 0;
    this.returns = 0;
    this.hud.setPoint("");
    this.pointUntil = 0;
    this.playSolo(base);
  }

  private syncHud() {
    const { settled, slot } = this;
    this.hud.sync({
      awaitingServe: settled.phase === "serving" && settled.serveAt === null,
      charge: this.myCharge,
      link: this.control.link,
      longestRally: settled.longest,
      phase: settled.phase,
      scoreAi: slot === 0 ? settled.scoreB : settled.scoreA,
      scoreYou: slot === 0 ? settled.scoreA : settled.scoreB,
    });
  }

  private showShot(kind: ContactKind, mine: boolean, powered: boolean) {
    this.hud.showShot(kind, mine, powered);
    this.shotUntil = this.elapsed + 0.7;
  }

  private updateServeMeter() {
    const { phase, serveAt } = this.settled;
    const active = phase === "serving" && serveAt !== null;
    this.hud.serveMeter(active ? Math.max(0, (serveAt - this.shownAt) * TICK_S) : null);
  }
}
