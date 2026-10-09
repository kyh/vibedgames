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
import type { ContactKind, ShotCharge } from "../shared/contact-shot";
import { bump, paddleStep } from "../shared/input";
import type { SlotInput } from "../shared/input";
import { newMatch, paddleOf, serveNow, simChecksum } from "../shared/sim";
import type { Arc, HitEvent, SimEvent, SimState, Slot } from "../shared/sim";
import { SPIN_TICKS } from "../shared/spin";

/** DEV-only room override (?room=): the two-client harness isolates each run
 *  so a stale room's match can't leak into assertions. */
const ROOM = (import.meta.env.DEV && new URLSearchParams(location.search).get("room")) || MP_ROOM;

/** A drawn ball moving further than this between two ticks jumped (a serve,
 *  the reset after a goal): drawn there at once, never swept across. */
const BALL_JUMP = 2;
/** Ticks back the effects scan looks for events confirmed late. */
const SCAN_TICKS = 60;

// ---- module helpers (pure) --------------------------------------------------

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const V3_ZERO = new THREE.Vector3(0, 0, 0);
const SCRATCH_M4 = new THREE.Matrix4();

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/**
 * Vertical fov (deg) for the current aspect. Landscape keeps the authored
 * CAM_FOV; below CAM_MIN_LANDSCAPE_ASPECT the HORIZONTAL fov of that
 * narrowest-landscape framing is held constant instead ("Hor+"), so portrait
 * phones widen vertically rather than cropping the paddle's ±PADDLE_X_MAX
 * travel out of frame. Continuous at the threshold. Slot B's 180° view
 * flip only negates rendered x/y — framing is symmetric, so no special case.
 */
const fovForAspect = (aspect: number): number => {
  if (aspect >= CAM_MIN_LANDSCAPE_ASPECT) {
    return CAM_FOV;
  }
  const tanHalfH = Math.tan(THREE.MathUtils.degToRad(CAM_FOV / 2)) * CAM_MIN_LANDSCAPE_ASPECT;
  return THREE.MathUtils.radToDeg(2 * Math.atan(tanHalfH / aspect));
};

/** Convert a legacy per-frame (60fps) lerp factor into a dt-correct one. */
const frameLerp = (perFrame: number, dt: number): number => 1 - (1 - perFrame) ** (dt * LEGACY_FPS);

/**
 * One step of a critically-damped spring toward `target` (Game Programming
 * Gems 4). Frame-rate independent; `omega` is the natural frequency (rad/s) —
 * higher snaps faster. Returns the new position and its carried velocity in a
 * shared scratch object (no per-frame allocation) — consume before calling again.
 */
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

const flashMaterial = (): THREE.MeshBasicMaterial =>
  // depthWrite off, like the shadow/ring overlays: the bars sit 0.004 above the
  // table and are usually invisible (opacity 0) — letting them write depth would
  // let the distance sort against the goal shockwave ring (spawned at the same
  // goal line, z 0.015) flip under camera breath/shake and flicker through the
  // dither pass.
  new THREE.MeshBasicMaterial({
    color: INK,
    depthWrite: false,
    opacity: 0,
    transparent: true,
  });

/** Smooth ±1 pseudo-noise: two incommensurate sines, decorrelated per seed. */
const noise = (t: number, seed: number): number =>
  0.6 * Math.sin(t + seed * 17.31) + 0.4 * Math.sin(t * 2.3 + seed * 31.7);

/** Radial ink→transparent gradient — a soft blob the dither pass speckles. */
const softCircleTexture = (): THREE.CanvasTexture => {
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

/** "#rrggbb" for a 24-bit hex color number. */
const cssHex = (hex: number): string => `#${hex.toString(16).padStart(6, "0")}`;

/**
 * Vertical sRGB gradient (plane top → bottom) for the backdrop wall. Marked
 * sRGB so its grey values linearize the same way THREE.Color does — keeping the
 * dither remap (t = lum / lum(BG)) matched to the intended halftone density.
 */
const verticalGradientTexture = (topHex: number, bottomHex: number): THREE.CanvasTexture => {
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

const arcProgress = (arc: Arc, y: number): number =>
  clamp((y - arc.fromY) / (arc.toY - arc.fromY), 0, 1);

/** Parabola peaking at ARC_PEAK halfway through the hop. */
const arcHeight = (arc: Arc, y: number): number => {
  const p = arcProgress(arc, y);
  return 4 * ARC_PEAK * p * (1 - p);
};

const pointCallout = (won: boolean, iScored: boolean): string => {
  if (won) {
    return "";
  }
  return iScored ? "YOU SCORE" : "RIVAL SCORES";
};

const otherSlot = (slot: Slot): Slot => (slot === 0 ? 1 : 0);

/** The ball and the rival's paddle at a fractional tick. */
interface Sample {
  rival: number;
  x: number;
  y: number;
}

/**
 * The ball and the rival's paddle at fractional tick `at`, blended between
 * the two ticks around it — except across a jump, which is drawn at once.
 * Undefined when the engine no longer holds those ticks.
 */
const sampleAt = (engine: Rollback, at: number, rival: Slot): Sample | undefined => {
  const tick = Math.floor(at);
  const now = engine.stateAt(tick);
  if (now === undefined) {
    return undefined;
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

/** A point waits for confirmation when a rival human defended it: their
 *  paddle is predicted, so the miss may be a misprediction. */
const awaitsConfirmation = (event: SimEvent, state: SimState, mine: Slot): boolean => {
  if (event.kind !== "point") {
    return false;
  }
  const defender = otherSlot(event.scorer);
  return defender !== mine && paddleOf(state, defender).human;
};

export class GameScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  // ---- match -----------------------------------------------------------------
  // The match runs in canonical frame (slot A defends −y, slot B +y) on the
  // lockstep sim (../shared/sim), driven by MatchControl: the room's ticks
  // with a rival, this client's own clock without one. Slot B renders the
  // world flipped 180° (`flip`) so its own paddle sits at the bottom.
  private readonly control: MatchControl;
  /** The state on screen, and the one the HUD reads — the same, unless a
   *  point still waits on confirmation (then the tick before it). */
  private shown: SimState;
  private settled: SimState;
  /** The fractional tick drawn last, the engine it came from, and the slot played. */
  private shownAt = 0;
  private shownEngine: Rollback | null = null;
  private slot: Slot = 0;
  // Effects already played, by key, within one match's scope; and the first
  // tick whose events may still change.
  private readonly fired = new Map<string, number>();
  private firedScope = "";
  private scanFrom = 0;
  // The ball and the rival's paddle as the timeline has them, and as drawn:
  // a rollback moves the timeline at once, the ease takes the jump out of
  // the picture instead.
  private readonly simBall = new THREE.Vector2();
  private readonly ballEase = new THREE.Vector2();
  private readonly drawnBall = new THREE.Vector2();
  private simRival = 0;
  private rivalEase = 0;
  /** Balls this client's paddle has returned, for the playtest's score. */
  private returns = 0;
  private powerShots = 0;
  private spinShots = 0;
  private frame = 0;
  /** Seed for the playtest's solo states. */
  private testSeed = 1 + Math.floor(Math.random() * 1_000_000);

  // ---- local input -----------------------------------------------------------
  // What this player's input says: the paddle target (canonical frame) and
  // the confirm / power-cancel press counters (see ../shared/input).
  private localX = 0;
  private presses = 0;
  private cancels = 0;

  // ---- wrapper pause -----------------------------------------------------
  // Only frozen when it's safe: with a rival sharing the room's clock the
  // match cannot wait, so the wrapper's overlay merely suspends local input
  // ("input") and the match plays on behind it.
  private pause: "none" | "input" | "frozen" = "none";

  // ---- feel state ------------------------------------------------------------
  private elapsed = 0;
  private playerPulse = 0;
  private aiPulse = 0;
  private readonly camKick = new THREE.Vector3();
  // Paddle-follow camera x offset (own field, smoothed).
  private camParallax = 0;
  // Carried velocity for the critically-damped spring.
  private camParallaxVel = 0;
  // Camera z duck, eased toward a target set by ball proximity.
  private camDip = 0;
  // 0-1; shake amplitude = trauma².
  private trauma = 0;
  private shakeTime = 0;
  // Seconds left of full-screen ink/paper swap.
  private invertFlash = 0;
  // Player's goal line (conceded to the rival).
  private flashNear = 0;
  // Rival's goal line (conceded to the player).
  private flashFar = 0;
  private trailAcc = 0;
  private readonly particles: ParticlePool;
  private readonly rings: RingPool;
  private readonly motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  private reducedMotion = this.motionQuery.matches;
  private shotUntil = 0;
  private pointUntil = 0;

  // ---- display objects ---------------------------------------------------------
  private readonly playerRing: THREE.Mesh;
  private readonly aiRing: THREE.Mesh;
  private readonly ball: THREE.Mesh;
  private readonly shadowMat: THREE.MeshBasicMaterial;
  private readonly shadow: THREE.Mesh;
  private readonly flashNearMat: THREE.MeshBasicMaterial;
  private readonly flashFarMat: THREE.MeshBasicMaterial;

  // ---- input -------------------------------------------------------------------
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly tablePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly planeHit = new THREE.Vector3();

  // Webcam hand tracking: latest wrist x ∈ [0,1] and when it was last seen.
  // While a hand is in frame it owns the paddle; pointer control resumes
  // HAND_TIMEOUT_MS after the last result (legacy never gave it back — bug).
  private handX: number | null = null;
  private handSeenAt = 0;
  private lastHandX: number | null = null;

  // Physical controller: left-stick x steers (hand > pad > pointer), A confirms.
  private readonly pad = new PhysicalGamepad();

  // Drag-to-pan camera offset; lerps back to rest while not dragging.
  private dragging = false;
  private readonly lastPointer = { x: 0, y: 0 };
  private readonly downAt = { x: 0, y: 0 };
  private readonly camDrag = new THREE.Vector3(0, CAM_START_OFFSET_Y, 0);

  // ---- HUD ----------------------------------------------------------------------
  private readonly hud = new Hud(() => this.bannerAction());

  constructor() {
    this.control = new MatchControl(ROOM, this.localInput());
    this.shown = this.control.driver.engine.confirmed;
    this.settled = this.shown;

    this.scene.background = new THREE.Color(BG);

    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(fovForAspect(aspect), aspect, 0.1, 100);
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
    const key = new THREE.DirectionalLight(0xff_ff_ff, 2);
    key.position.set(-4, -8, 9);
    this.scene.add(key);

    // Table: a single flat outline on the z=0 play plane (the old box edges
    // drew a second, lower rectangle that doubled every side line).
    const ink = new THREE.MeshBasicMaterial({ color: INK });
    const tablePlane = new THREE.PlaneGeometry(COURT_W, COURT_D);
    const table = new THREE.LineSegments(
      new THREE.EdgesGeometry(tablePlane),
      new THREE.LineBasicMaterial({ color: INK }),
    );
    // EdgesGeometry copied the source; it never joins the scene.
    tablePlane.dispose();
    this.scene.add(table);

    // Dashed net across mid-court — the classic Pong read, one InstancedMesh of
    // ink quads (densest dither speckle). Inset so the end dashes clear the rails.
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

    // Backdrop: a single tall UNLIT plane far behind the rival, leaning back to
    // face the tilted camera. Its faint vertical gradient (a touch below paper at
    // the horizon → clean paper toward the top) reads as a soft atmospheric
    // horizon and gives the orbit parallax a distant anchor to turn against.
    // Unlit, so color IS luminance — exactly what the dither pass quantizes.
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
      new THREE.MeshPhongMaterial({ color: 0x11_11_11, shininess: 40, specular: 0xbb_bb_bb }),
    );
    this.ball.position.z = BALL_R;
    this.scene.add(this.ball);

    // Soft radial-gradient shadow — the falloff dithers into a speckle edge.
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

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.fov = fovForAspect(aspect);
    this.camera.updateProjectionMatrix();
  }

  // ---- seat ------------------------------------------------------------------

  /** 180° view flip: slot B renders the canonical world upside-down so its
   *  own paddle sits at the near (bottom) edge, facing the opponent. */
  private get flip(): 1 | -1 {
    return this.slot === 0 ? 1 : -1;
  }

  /** A rival shares this match's clock (so the AI stands down and the match
   *  cannot be paused). */
  hasLiveOpponent(): boolean {
    return this.control.ticking;
  }

  /** This player's input as it rides the tick room. */
  private localInput(): SlotInput {
    return { c: this.presses, k: this.cancels, x: paddleStep(this.localX) };
  }

  // ---- wrapper pause ---------------------------------------------------------

  /** Wrapper asked us to pause. With a rival on the room's clock the match
   *  keeps running behind the overlay and only our input is suspended. A
   *  queued power shot is released either way. */
  requestPause(): void {
    this.pause = this.control.ticking ? "input" : "frozen";
    this.dragging = false;
    this.handX = null;
    this.lastHandX = null;
    this.cancelMyPower();
  }

  requestResume(): void {
    this.pause = "none";
    // Poll held buttons now so the next gameplay poll cannot reuse the resume press.
    this.pad.update();
  }

  // ---- input ---------------------------------------------------------------

  // Alt-tab can strand a mid-flight camera drag — clear it so the pan doesn't
  // resume by itself when focus returns.
  private readonly onBlur = (): void => {
    this.dragging = false;
    this.cancelMyPower();
  };

  /** Wrist landmark x ∈ [0,1] from the webcam tracker (also the DEV hook). */
  handleHandPosition(x: number): void {
    if (this.pause !== "none" || !Number.isFinite(x) || x < 0 || x > 1) {
      return;
    }
    this.handX = x;
    this.handSeenAt = performance.now();
  }

  /** Fresh fist edge: arm a charged return, or serve/rematch between rallies. */
  handleGestureConfirm(): void {
    this.confirm();
  }

  /** Latest wrist x, or null once no hand has been seen for HAND_TIMEOUT_MS. */
  private currentHandX(): number | null {
    if (this.handX === null) {
      return null;
    }
    return performance.now() - this.handSeenAt < HAND_TIMEOUT_MS ? this.handX : null;
  }

  // Mobile controls ARE these pointer handlers: an absolute touch-drag maps
  // 1:1 onto the paddle (raycast to the table plane) and a tap serves — a
  // relative joystick/button overlay (@vibedgames/gamepad's VirtualGamepad)
  // would be strictly worse for pong, so only its PhysicalGamepad (real pads)
  // is used here.
  //
  // Legacy gimmick: while dragging, the pointer pans the camera and the
  // paddle ignores it; otherwise pointermove drives the paddle (unless a
  // hand currently owns it).
  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.pause !== "none") {
      return;
    }
    if (this.dragging) {
      if (e.buttons === 0) {
        // Button released outside the window.
        this.dragging = false;
      } else {
        this.camDrag.x -= (e.clientX - this.lastPointer.x) * DRAG_PAN_SCALE;
        this.camDrag.y += (e.clientY - this.lastPointer.y) * DRAG_PAN_SCALE;
        this.lastPointer.x = e.clientX;
        this.lastPointer.y = e.clientY;
        return;
      }
    }
    // A hand in frame or a deflected stick owns the paddle.
    if (this.currentHandX() !== null || this.padSteerX() !== null) {
      return;
    }
    const x = this.pointerToTableX(e);
    if (x !== null) {
      this.localX = x;
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.pause !== "none") {
      return;
    }
    // Drag-pan is mouse-only: on touch, pointermove must keep driving the
    // paddle (it's the only non-camera control there).
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

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.pause === "none" && this.dragging && e.pointerType === "mouse") {
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
      if (moved < CLICK_DRAG_TOLERANCE_PX) {
        this.confirm();
      }
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
    // The raycast is in scene space; slot B's world is flipped, so map the hit
    // back into the canonical frame the paddle lives in.
    return hit ? clamp(this.flip * hit.x, -PADDLE_X_MAX, PADDLE_X_MAX) : null;
  }

  /**
   * A fresh confirm — serve, arm a charged return, or rematch, whichever the
   * match is ready for: one press, which the sim reads on the tick it lands.
   */
  private confirm(): void {
    // Frozen for the wrapper's pause overlay: the webcam hand loop keeps
    // running (per its own contract) but must not wake the sim through a
    // fist gesture while we're paused.
    if (this.pause !== "none") {
      return;
    }
    // Still handshaking: the room has not admitted this client yet. A tap
    // here is intent, not noise: rather than swallow it and leave the player
    // staring at "connecting" for the rest of the fallback window, take it as
    // "play now" and serve solo. Not once a room has been joined: a tap during
    // a reconnect would abandon the match.
    if (this.control.session.connectionStatus === "connecting") {
      this.playSolo();
    }
    this.presses = bump(this.presses);
  }

  /**
   * The banner's button. While the link is down it reads PLAY AI, and the
   * player asked for exactly that: a reconnecting room is left for a solo
   * game too, which a tap on the table never does. Otherwise it is a
   * confirm, like a tap — serve, or rematch.
   */
  private bannerAction(): void {
    if (this.pause === "none" && this.control.session.connectionStatus === "reconnecting") {
      this.playSolo();
    }
    this.confirm();
  }

  /** Release an armed power shot (pause, blur, a lost hand). */
  private cancelMyPower(): void {
    if (paddleOf(this.shown, this.slot).charge.kind === "armed") {
      this.cancels = bump(this.cancels);
    }
  }

  /** Abandon matchmaking for a local solo game against the AI. */
  private playSolo(base?: SimState): void {
    this.control.goOffline(this.localInput(), base);
  }

  /** Webcam-hand / controller paddle control. The view flip keeps "screen
   *  right = paddle right" in slot B too. */
  private applyPaddleInput(dt: number): void {
    if (this.pause !== "none") {
      return;
    }
    const { flip } = this;

    // Hand tracking owns the paddle while a hand is in frame. Legacy mapping:
    // targetX = (1 - wristX)·9 − 4.5 clamped ±4.5, smoothed by an adaptive
    // per-60fps-frame lerp of clamp(0.2 + |Δwrist|·10, 0, 1) — converted to dt.
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

    // No hand: a deflected left stick owns the paddle target next (pointer
    // moves are ignored while it holds — see onPointerMove), mapped onto the
    // same clamped ±PADDLE_X_MAX travel the pointer raycast lands in.
    const padX = this.padSteerX();
    if (padX !== null) {
      const targetX = flip * padX * PADDLE_X_MAX;
      this.localX += (targetX - this.localX) * frameLerp(PAD_LERP, dt);
    }
  }

  /** Left-stick x with the dead zone removed and the rest renormalized to
   *  ±1 (so dead center and the walls stay reachable), or null while the
   *  stick is centered — null means the pad is NOT steering this frame. */
  private padSteerX(): number | null {
    const { dx } = this.pad.getStick();
    if (Math.abs(dx) <= PAD_DEAD_ZONE) {
      return null;
    }
    const norm = (Math.abs(dx) - PAD_DEAD_ZONE) / (1 - PAD_DEAD_ZONE);
    return Math.sign(dx) * Math.min(1, norm);
  }

  // ---- frame ----------------------------------------------------------------

  update(dt: number): void {
    if (this.pause === "frozen" && this.control.ticking) {
      // A rival was seated behind the overlay: the match cannot wait for us.
      this.pause = "input";
    }
    if (this.pause === "frozen") {
      // The solo clock stops with the picture; the session keeps running.
      this.control.frame(this.localInput(), dt * 1000, false);
      return;
    }
    this.frame += 1;
    this.elapsed += dt;
    this.expireCallouts();
    this.invertFlash = Math.max(0, this.invertFlash - dt);

    // Poll the pad every non-paused frame, so A stays as responsive as a
    // click (confirm() carries the same guards either way).
    this.pad.update();
    if (this.pad.justPressed("a")) {
      this.confirm();
    }
    this.applyPaddleInput(dt);

    const horizon = this.control.frame(this.localInput(), dt * 1000, true);
    this.present(horizon, dt);
    this.playEvents();
    this.syncHud();

    // Hit-stop: the ball and the visual decays hold for the sim's beat while
    // rendering continues. Deliberate exceptions that keep ticking: the
    // invert flash (above — so the goal flash ends inside the goal freeze),
    // the shake oscillator (a frozen offset reads as a glitch, not a shake),
    // the paddles (input) and the drag-pan camera (user input).
    if (this.shown.freeze > 0) {
      this.shakeTime += dt;
      this.placePaddles();
      this.composeCamera();
    } else {
      this.updateVisuals(dt);
    }
  }

  /**
   * Bring the picture to fractional tick `horizon`. When a rollback rewrote
   * the ticks drawn last frame, the ball and the rival's paddle keep their
   * drawn place and the correction eases out over BALL_EASE_S instead of
   * jumping — the timeline itself is never smoothed.
   */
  private present(horizon: number, dt: number): void {
    const { driver } = this.control;
    const { engine } = driver;
    const rival = otherSlot(driver.mySlot);
    if (driver.mySlot !== this.slot) {
      // A new seat flips the view: keep our paddle where it is on screen.
      this.slot = driver.mySlot;
      this.localX = -this.localX;
    }
    if (engine === this.shownEngine) {
      const again = sampleAt(engine, this.shownAt, rival);
      if (again !== undefined) {
        this.absorbCorrection(again);
      }
    } else {
      // Another match entirely: nothing to ease.
      this.shownEngine = engine;
      this.ballEase.set(0, 0);
      this.rivalEase = 0;
      this.scanFrom = engine.confirmedTick;
    }
    const at = clamp(horizon, engine.confirmedTick - SCAN_TICKS, engine.predictedTick + 0.999);
    this.shownAt = at;
    this.shown = engine.stateAt(Math.floor(at)) ?? engine.confirmed;
    const now = sampleAt(engine, at, rival) ?? {
      rival: paddleOf(this.shown, rival).x,
      x: this.shown.ball.x,
      y: this.shown.ball.y,
    };
    this.simBall.set(now.x, now.y);
    this.simRival = now.rival;
    const keep = Math.exp(-dt / BALL_EASE_S);
    this.ballEase.multiplyScalar(keep);
    this.rivalEase *= keep;
    this.drawnBall.set(now.x + this.ballEase.x, now.y + this.ballEase.y);
  }

  /** The timeline moved under the drawn picture: fold the jump into the eases. */
  private absorbCorrection(again: Sample): void {
    const dx = this.simBall.x - again.x;
    const dy = this.simBall.y - again.y;
    if (Math.hypot(dx, dy) < BALL_SNAP) {
      this.ballEase.x += dx;
      this.ballEase.y += dy;
    } else {
      this.ballEase.set(0, 0);
    }
    const drx = this.simRival - again.rival;
    this.rivalEase = Math.abs(drx) < BALL_SNAP ? this.rivalEase + drx : 0;
  }

  /** The rival's paddle as drawn. */
  private get rivalX(): number {
    return this.simRival + this.rivalEase;
  }

  /**
   * Play every event on the ticks shown so far, once each (keys name events
   * across re-simulation). A point a rival human defended waits for its tick
   * to be confirmed, and until then the HUD reads the tick before it — so a
   * misprediction never flashes a goal that did not happen.
   */
  private playEvents(): void {
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
    // Ticks both confirmed and shown can no longer change.
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

  private play(event: SimEvent): void {
    switch (event.kind) {
      case "serve": {
        sfx.serve();
        notifyGameStarted();
        this.hud.setPoint("");
        this.pointUntil = 0;
        // The rally counter resets with the new rally.
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

  /** Shot / point callouts clear themselves on the visual clock. */
  private expireCallouts(): void {
    if (this.shotUntil > 0 && this.elapsed >= this.shotUntil) {
      this.shotUntil = 0;
      this.hud.hideShot();
    }
    if (this.pointUntil > 0 && this.elapsed >= this.pointUntil) {
      this.pointUntil = 0;
      this.hud.setPoint("");
    }
  }

  // ---- effects -----------------------------------------------------------------

  /**
   * Paddle-contact juice in the LOCAL view frame: ring pop, ball squash along
   * travel, camera kick with the ball plus a pinch of trauma shake, ink
   * sparks fanning out along the return, a contact ring on the table,
   * climbing-pitch blip. The hit-stop beat itself is the sim's.
   */
  private hitFx(hit: HitEvent): void {
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
      // Reuse the ink contact pool for the shot style and charged impact.
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

  /**
   * Point juice in the LOCAL view frame: the loudest beat — full-screen invert
   * flash, heavy shake, an ink explosion + shockwave at the crossing, the
   * conceded-goal bar flashes, and win confetti on match point.
   */
  private pointFx(iScored: boolean, cx: number, cy: number, won: boolean): void {
    const { flip } = this;
    const sx = flip * cx;
    const sy = flip * cy;
    this.hud.popScore(iScored ? "you" : "ai");
    // The scored-on goal flashes: I scored → the far (opponent) line; else mine.
    if (iScored) {
      this.flashFar = 1;
    } else {
      this.flashNear = 1;
    }

    this.invertFlash = this.reducedMotion ? 0 : INVERT_FLASH_S;
    this.trauma = Math.min(1, this.trauma + TRAUMA_GOAL);
    this.particles.burst({ dirY: -Math.sign(sy), x: sx, y: sy, z: BALL_R, ...BURST_GOAL });
    this.rings.spawn({ x: sx, y: sy, ...RING_GOAL });
    // The rally is over.
    this.hud.hideCombo();
    this.hud.hideShot();
    this.shotUntil = 0;

    this.hud.setPoint(pointCallout(won, iScored));
    this.pointUntil = won ? 0 : this.elapsed + AUTO_SERVE_S;
    if (won) {
      sfx.win(iScored);
      // Confetti rain from above center — pure flair on the match climax.
      if (!this.reducedMotion) {
        this.particles.burst({ x: 0, y: 0, z: CONFETTI_Z, ...BURST_CONFETTI });
      }
    } else {
      sfx.score(iScored);
    }
  }

  private wallFx(cx: number, cy: number): void {
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

  private squashBall(axis: "x" | "y" | "z"): void {
    const s = this.ball.scale;
    s.set(1 + SQUASH / 2, 1 + SQUASH / 2, 1 + SQUASH / 2);
    s[axis] = 1 - SQUASH;
  }

  // ---- visuals -------------------------------------------------------------------

  /** `playerRing` is always the LOCAL paddle (bottom), `aiRing` the rival
   *  (top); both from canonical x through the view flip. Runs through
   *  hit-stop too: paddles answer input every frame. Our own paddle is drawn
   *  from the input itself — it is ours, and never waits on a tick. */
  private placePaddles(): void {
    const { flip } = this;
    this.playerRing.position.x = flip * this.localX;
    this.aiRing.position.x = flip * this.rivalX;
  }

  private updateVisuals(dt: number): void {
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
    // Waiting to serve: the ball breathes — anticipation instead of a dead prop.
    if (shown.phase === "serving" && !this.reducedMotion) {
      this.ball.scale.setScalar(1 + SERVE_PULSE_SCALE * Math.sin(this.elapsed * SERVE_PULSE_FREQ));
    }

    // Trail: stationary ghosts dropped at a fixed rate, so a faster ball
    // stretches them into a longer streak. Each dissolves ink → paper.
    // Ghosts spawned in the same frame are back-projected along velocity to
    // their ideal emission times, keeping trail spacing frame-rate-invariant.
    if (shown.phase === "rally" && !shown.parked) {
      // Speed streak: the trail thickens & lengthens with rally pace, so the
      // dither speckle density reads as velocity (0 at serve → 1 at the cap).
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
          // A fine parallel ink stroke sits on the curving side of the trail.
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

    // Drag-pan offset eases back to rest only while not dragging (legacy:
    // 0.1 per 60fps frame). Orientation stays fixed — pan, don't re-aim.
    if (!this.dragging) {
      this.camDrag.lerp(V3_ZERO, frameLerp(CAM_RETURN_LERP, dt));
    }
    this.camKick.multiplyScalar(Math.exp(-NUDGE_DECAY * dt));
    // Ball-proximity dip: duck lower as the ball nears the player's side (0 on
    // the rival's half → CAM_DIP_MAX at the player's goal), eased so it never jitters.
    const dipTarget = CAM_DIP_MAX * clamp(-(flip * ballY) / GOAL_Y, 0, 1);
    this.camDip += (dipTarget - this.camDip) * (1 - Math.exp(-CAM_DIP_RATE * dt));
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    this.shakeTime += dt;

    // Camera-strafe drive: a smoothed, normalized −1..1 tracking the paddle x,
    // feeding the lateral camera strafe in composeCamera. Critically damped, in
    // its OWN field — never camDrag (which self-centers every frame).
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

  /**
   * Drives the camera each frame: it STRAFES along the player's baseline with the
   * paddle and aims at the ENEMY paddle, so the view yaws to keep the opponent in
   * front of you as you move ("behind your paddle, facing the opponent"). Then
   * the cosmetic translational offsets (drag-pan, kick, idle breath, trauma
   * shake) are added AFTER the aim, so they translate the view without re-aiming,
   * plus a shake/breath roll. Offsets stay << shake so impacts mask them.
   */
  private composeCamera(): void {
    if (this.reducedMotion) {
      this.camera.position.set(this.camDrag.x, CAM_POS.y + this.camDrag.y, CAM_POS.z);
      this.camera.lookAt(0, CAM_AIM_Y, PADDLE_Z);
      return;
    }
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
    const { arc, lift } = this.shown;
    return BALL_R + (arc ? arcHeight(arc, this.drawnBall.y) * lift : 0);
  }

  /** True while a goal's full-screen ink/paper swap is live (dither pass reads this). */
  isScreenInverted(): boolean {
    return !this.reducedMotion && this.invertFlash > 0;
  }

  setReducedMotion(enabled: boolean): void {
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

  // ---- playtest ----------------------------------------------------------------

  private get myCharge(): ShotCharge {
    return paddleOf(this.shown, this.slot).charge;
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
      // How the match runs: on the room's ticks (rollback) or this client's clock.
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
      // A point takes about a minute against this rival, longer than most
      // playtests run; a return is the player's own work and lands in seconds.
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
  seed(seed: number): void {
    this.testSeed = seed;
    this.setTestState("active-play");
  }

  setTestState(name: string): void {
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

  // ---- HUD -----------------------------------------------------------------

  private syncHud(): void {
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

  private showShot(kind: ContactKind, mine: boolean, powered: boolean): void {
    this.hud.showShot(kind, mine, powered);
    this.shotUntil = this.elapsed + 0.7;
  }

  /** Seconds of auto-serve dead air left, for the countdown bar. */
  private updateServeMeter(): void {
    const { phase, serveAt } = this.settled;
    const active = phase === "serving" && serveAt !== null;
    this.hud.serveMeter(active ? Math.max(0, (serveAt - this.shownAt) * TICK_S) : null);
  }
}
