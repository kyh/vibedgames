import * as THREE from "three";
import { notifyGameStarted } from "@repo/embed";

import { ParticlePool } from "../fx/particles";
import { sfx, toggleMute } from "../fx/sfx";
import { RingPool } from "../fx/shock-rings";
import { NetSession } from "../net/session";
import {
  MP_ROOM,
  MP_MAX_PLAYERS,
  OFFLINE_FALLBACK_MS,
  NET_TICK_HZ,
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
  CAM_MIN_LANDSCAPE_ASPECT,
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
import { COARSE_INPUT } from "../shared/input-mode";

type Phase = "serving" | "rally" | "won";

/** Cosmetic hop: visual z parabola from the hit point to a landing y. */
type Arc = { fromY: number; toY: number };

export class GameScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  // ---- simulation state (x/y plane only — arc z is purely visual) -----------
  // All sim state is in the HOST's canonical frame: `playerX` is slot A (the
  // near paddle at -PADDLE_Y), `aiX` is slot B (the far paddle at +PADDLE_Y).
  // The host owns slot A + the ball; the guest owns slot B. A guest renders the
  // whole canonical world flipped 180° (`this.flip`) so its own paddle sits at
  // the bottom of the screen — see updateVisuals.
  private phase: Phase = "serving";
  private ballPos = new THREE.Vector2(0, 0);
  private ballVel = new THREE.Vector2(0, 0);
  private arc: Arc | null = null;
  private playerX = 0;
  private aiX = 0;
  private scoreYou = 0; // local player's score (host: slot A, guest: slot B)
  private scoreAi = 0; // opponent's score
  private rallySpeed = RALLY_SPEED_BASE;
  private rallyHits = 0;
  private serveAt: number | null = null; // elapsed time of the next auto-serve

  // ---- multiplayer -----------------------------------------------------------
  private net: NetSession;
  private netAcc = 0; // host: seconds since the last shared-state broadcast
  private paddleAcc = 0; // seconds since the last paddle broadcast
  private hostSeq = 0; // host: monotonically increases each shared broadcast
  private lastSeq = -1; // guest: last applied host sequence number
  private connWas = false; // tracks the connecting→live transition for the HUD
  private oppWas = false; // tracks opponent join/leave for the HUD
  private roleWasGuest: boolean | null = null; // last role while live (host migration)

  // ---- wrapper pause -----------------------------------------------------
  // Only frozen when it's safe: a live human opponent must never desync from
  // us, so requestPause() no-ops while one is connected (`froze` stays false)
  // and update() keeps running behind the wrapper's overlay.
  private paused = false;
  private froze = false;

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
  private bannerEl = el("banner");
  private comboEl = el("combo");
  private serveMeterEl = el("serve-meter");
  private oppLabelEl = el("opp-label");
  private netInfoEl = el("netinfo");
  private serveMeterShown = false; // cached so we only touch classList on transitions

  constructor() {
    this.net = new NetSession({
      room: MP_ROOM,
      maxPlayers: MP_MAX_PLAYERS,
      fallbackMs: OFFLINE_FALLBACK_MS,
      onEvent: (event, payload, from) => this.handleEvent(event, payload, from),
    });

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
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);

    this.syncHud();
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.fov = fovForAspect(aspect);
    this.camera.updateProjectionMatrix();
  }

  // ---- role / paddle ownership ---------------------------------------------

  /** A guest (second player) is connected but not the host. */
  private isGuest(): boolean {
    return this.net.live && !this.net.offline && !this.net.isHost;
  }

  /** True when the local player owns slot A (host or solo). Guest owns slot B. */
  private get mySlotA(): boolean {
    return !this.isGuest();
  }

  /** 180° view flip: the guest renders the canonical world upside-down so its
   *  own paddle sits at the near (bottom) edge, facing the opponent. */
  private get flip(): 1 | -1 {
    return this.mySlotA ? 1 : -1;
  }

  private get myPaddle(): number {
    return this.mySlotA ? this.playerX : this.aiX;
  }
  private set myPaddle(x: number) {
    if (this.mySlotA) this.playerX = x;
    else this.aiX = x;
  }
  private get oppPaddle(): number {
    return this.mySlotA ? this.aiX : this.playerX;
  }

  /** A human opponent is sharing the room (so the AI stands down). */
  private hasOpponent(): boolean {
    return this.net.otherPlayer() !== null;
  }

  /** True while actually connected (not solo) to a room with another player. */
  private hasLiveOpponent(): boolean {
    return this.net.live && !this.net.offline && this.hasOpponent();
  }

  // ---- wrapper pause ---------------------------------------------------------

  /** Wrapper asked us to pause. No-ops while a live human opponent is
   *  connected — freezing here would desync the shared rally state; the
   *  wrapper's overlay still shows, the match just keeps running behind it. */
  requestPause(): void {
    if (this.hasLiveOpponent()) return;
    this.froze = true;
    this.paused = true;
  }

  /** Wrapper resume. Only unfreezes if requestPause() actually froze us. */
  requestResume(): void {
    if (!this.froze) return;
    this.froze = false;
    this.paused = false;
  }

  /** The old host left mid-game and the server promoted us. Our slot flips
   *  from B to A, which silently changes what every canonical-frame field
   *  MEANS on screen (the view flip negates x) — remap so nothing teleports,
   *  then restart the point from a clean serve on our own clock. */
  private becomeHost(): void {
    const myOld = this.aiX; // slot B was ours
    const oppOld = this.playerX;
    this.playerX = -myOld; // same screen position under the new flip sign
    this.aiX = -oppOld;
    if (this.phase !== "won") {
      // The rally state (ball, streak, serve clock) was the old host's; the
      // serve clock in particular was in ITS `elapsed` timeline, which can sit
      // hours ahead of ours and stall the auto-serve forever.
      this.phase = "serving";
      this.ballPos.set(0, 0);
      this.ballVel.set(0, 0);
      this.arc = null;
      this.rallyHits = 0;
      this.rallySpeed = RALLY_SPEED_BASE;
      this.serveAt = this.elapsed + AUTO_SERVE_S;
    } else {
      this.serveAt = null; // rematch waits for confirm, as usual
    }
    this.hostSeq = 0;
    this.lastSeq = -1;
    this.syncHud();
  }

  // ---- input ---------------------------------------------------------------

  // The paddle is gesture/pointer-driven; the keyboard's only job is the
  // unadvertised mute toggle (Escape-pause lives in @repo/embed).
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "KeyM") toggleMute();
  };

  // Alt-tab can strand a mid-flight camera drag — clear it so the pan doesn't
  // resume by itself when focus returns.
  private onBlur = (): void => {
    this.dragging = false;
  };

  /** Wrist landmark x ∈ [0,1] from the webcam tracker (also the DEV hook). */
  handleHandPosition(x: number): void {
    this.handX = x;
    this.handSeenAt = performance.now();
  }

  /** Closed-fist edge from the hand tracker — cam-only serve/rematch confirm. */
  handleGestureConfirm(): void {
    this.confirm();
  }

  /** Latest wrist x, or null once no hand has been seen for HAND_TIMEOUT_MS. */
  private currentHandX(): number | null {
    if (this.handX === null) return null;
    return performance.now() - this.handSeenAt < HAND_TIMEOUT_MS ? this.handX : null;
  }

  // Mobile controls ARE these pointer handlers: an absolute touch-drag maps
  // 1:1 onto the paddle (raycast to the table plane) and a tap serves — a
  // relative joystick/button overlay (@vibedgames/gamepad) would be strictly
  // worse for pong, so it is deliberately not used here.
  //
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
    if (x !== null) this.myPaddle = x;
  };

  private onPointerDown = (e: PointerEvent): void => {
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
    // The raycast is in scene space; a guest's world is flipped, so map the hit
    // back into the canonical frame the paddle slot lives in.
    return hit ? clamp(this.flip * hit.x, -PADDLE_X_MAX, PADDLE_X_MAX) : null;
  }

  /** Fist / click / tap: rematch when won, serve when waiting. */
  private confirm(): void {
    // Frozen for the wrapper's pause overlay: the webcam hand loop keeps
    // running (per its own contract) but must not wake the sim through a
    // fist gesture while we're paused.
    if (this.paused) return;
    // Still handshaking: a reflexive tap must not start a phantom rally that
    // sits frozen until the connection resolves.
    if (!this.net.live) return;
    // A guest can't touch the authoritative ball/score — forward the intent so
    // the host serves / rematches for both of us.
    if (this.isGuest()) {
      this.net.sendEvent("confirm", {});
      return;
    }
    if (this.phase === "won") {
      this.scoreYou = 0;
      this.scoreAi = 0;
      this.phase = "serving";
      this.syncHud();
    }
    if (this.phase === "serving") this.serve();
  }

  private serve(): void {
    notifyGameStarted();
    // Always toward slot A (the host), ±SERVE_SPREAD rad of straight down.
    const angle = -Math.PI / 2 + (Math.random() * 2 - 1) * SERVE_SPREAD;
    this.rallySpeed = RALLY_SPEED_BASE;
    this.rallyHits = 0;
    this.serveAt = null;
    this.comboEl.style.opacity = "0"; // the rally counter resets with the new rally
    this.ballVel.set(Math.cos(angle) * this.rallySpeed, Math.sin(angle) * this.rallySpeed);
    this.phase = "rally";
    sfx.serve();
    this.emitBeat("serve", {});
    this.syncHud();
  }

  // ---- simulation ------------------------------------------------------------

  update(dt: number): void {
    if (this.paused) return;
    this.elapsed += dt;
    this.invertFlash = Math.max(0, this.invertFlash - dt);
    this.net.tick();

    // Reflect connecting→live and opponent join/leave in the HUD once each.
    if (this.net.live !== this.connWas) {
      this.connWas = this.net.live;
      this.syncHud();
    }
    const opp = this.net.live && this.hasOpponent();
    if (opp !== this.oppWas) {
      this.oppWas = opp;
      this.syncHud();
    }
    if (this.net.live && !this.net.offline) {
      // Host migration: the server elected us after the old host left (the
      // check spans reconnect gaps, when `live` briefly drops).
      const guestNow = this.isGuest();
      if (this.roleWasGuest === true && !guestNow) this.becomeHost();
      this.roleWasGuest = guestNow;
    }
    if (!this.net.live) {
      // Still handshaking with the party server: render an idle court rather
      // than a frozen black frame.
      this.updateVisuals(dt);
      return;
    }

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

    // Paddle input + a smoothed read of the opponent's paddle run in every role.
    this.applyPaddleInput(dt);
    this.smoothOppPaddle(dt);

    if (this.isGuest()) {
      // Guests never simulate: they render the host's authoritative ball,
      // dead-reckoned between the ~30 Hz snapshots so it stays smooth.
      this.applyGuestShared(dt);
    } else {
      // Host / solo: the authoritative simulation.
      if (this.phase === "serving" && this.serveAt !== null && this.elapsed >= this.serveAt) {
        this.serve();
      }
      if (this.phase === "rally") {
        if (!this.hasOpponent()) this.updateAi(dt); // AI fills in until a human joins
        this.updateBall(dt);
      }
      this.broadcastShared(dt);
    }

    this.broadcastPaddle(dt);
    this.updateVisuals(dt);
  }

  /** Webcam-hand paddle control, routed to the owned slot. The view flip
   *  keeps "screen right = paddle right" for the guest too. */
  private applyPaddleInput(dt: number): void {
    const flip = this.flip;

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
      this.myPaddle += (targetX - this.myPaddle) * frameLerp(perFrame, dt);
    } else {
      this.lastHandX = null;
    }
  }

  /** Ease the opponent's paddle toward its last networked position (no-op when
   *  alone — the AI or nobody owns that slot then). */
  private smoothOppPaddle(dt: number): void {
    const other = this.net.otherPlayer();
    const raw = other?.state?.["paddle"];
    if (typeof raw !== "number") return;
    const target = clamp(raw, -PADDLE_X_MAX, PADDLE_X_MAX);
    const next = this.oppPaddle + (target - this.oppPaddle) * frameLerp(0.5, dt);
    if (this.mySlotA) this.aiX = next;
    else this.playerX = next;
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
      this.wallFx(pos.x, pos.y);
      this.emitBeat("wall", { x: pos.x, y: pos.y });
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
    const towardY = side === "player" ? 1 : -1;

    // Every return raises the rally speed — the pace ramp.
    this.rallyHits += 1;
    this.rallySpeed = Math.min(RALLY_SPEED_MAX, this.rallySpeed + RALLY_SPEED_STEP);
    this.ballVel.copy(reflectOffPaddle(this.ballPos.x, paddleX, towardY, this.rallySpeed));
    this.arc = {
      fromY: this.ballPos.y,
      toY: towardY * (ARC_LAND_MIN + Math.random() * (ARC_LAND_MAX - ARC_LAND_MIN)),
    };

    // Juice — replayed on the guest via the "phit" beat with the same inputs.
    this.paddleHitFx(
      this.ballPos.x,
      this.ballPos.y,
      this.ballVel.x,
      this.ballVel.y,
      side === "player",
      this.rallyHits,
    );
    this.emitBeat("phit", {
      x: this.ballPos.x,
      y: this.ballPos.y,
      vx: this.ballVel.x,
      vy: this.ballVel.y,
      a: side === "player",
      n: this.rallyHits,
    });
  }

  /**
   * Paddle-contact juice in the LOCAL view frame: hit-stop beat, ring pop, ball
   * squash along travel, camera kick with the ball plus a pinch of trauma
   * shake, ink sparks fanning out along the return, a contact ring on the
   * table, climbing-pitch blip. Canonical inputs are flipped into the view;
   * `slotA` says whether the contacting paddle is slot A, and the local flip
   * decides whether that reads as "mine" (near/bottom) or the opponent's.
   */
  private paddleHitFx(
    cx: number,
    cy: number,
    cvx: number,
    cvy: number,
    slotA: boolean,
    rallyHits: number,
  ): void {
    const flip = this.flip;
    const sx = flip * cx;
    const sy = flip * cy;
    const mine = slotA === this.mySlotA;

    this.freeze = HIT_STOP_PADDLE;
    this.trauma = Math.min(1, this.trauma + TRAUMA_PADDLE);
    if (mine) this.playerPulse = 1;
    else this.aiPulse = 1;
    this.squashBall("y");
    this.camKick.set(cvx * flip * NUDGE_SCALE, cvy * flip * NUDGE_SCALE, 0);
    this.particles.burst({
      x: sx,
      y: sy,
      z: this.ballHeight(),
      dirX: cvx * flip,
      dirY: cvy * flip,
      ...BURST_PADDLE,
    });
    this.rings.spawn({ x: sx, y: mine ? -PADDLE_Y : PADDLE_Y, ...RING_PADDLE });
    this.showCombo(rallyHits);
    sfx.paddleHit(rallyHits);
  }

  private onPoint(scorer: "you" | "ai"): void {
    // Canonical: "you" = slot A scored (ball crossed the far +GOAL_Y line).
    const goalY = scorer === "you" ? GOAL_Y : -GOAL_Y;
    const crossX = clamp(this.ballPos.x, -WALL_X, WALL_X);
    if (scorer === "you") {
      this.scoreYou += 1;
      popScore(this.scoreYouEl);
    } else {
      this.scoreAi += 1;
      popScore(this.scoreAiEl);
    }

    this.ballPos.set(0, 0);
    this.ballVel.set(0, 0);
    this.arc = null;
    const won = this.scoreYou >= WIN_SCORE || this.scoreAi >= WIN_SCORE;
    this.phase = won ? "won" : "serving";
    this.freeze = won ? HIT_STOP_WIN : HIT_STOP_GOAL;
    if (!won) this.serveAt = this.elapsed + AUTO_SERVE_S;

    this.pointFx(scorer === "you", crossX, goalY, won);
    this.emitBeat("point", { a: scorer === "you", x: crossX, y: goalY, won });
    this.syncHud();
  }

  /**
   * Point juice in the LOCAL view frame: the loudest beat — full-screen invert
   * flash, sim hold, heavy shake, an ink explosion + shockwave at the crossing,
   * the conceded-goal bar flashes, and win confetti on match point. `scorerSlotA`
   * plus the local flip decide whether the near or far goal lit up and whether
   * the win/score sfx reads as ours.
   */
  private pointFx(scorerSlotA: boolean, cx: number, cy: number, won: boolean): void {
    const flip = this.flip;
    const sx = flip * cx;
    const sy = flip * cy;
    const iScored = scorerSlotA === this.mySlotA;
    // The scored-on goal flashes: I scored → the far (opponent) line; else mine.
    if (iScored) this.flashFar = 1;
    else this.flashNear = 1;

    this.invertFlash = INVERT_FLASH_S;
    this.trauma = Math.min(1, this.trauma + TRAUMA_GOAL);
    this.particles.burst({ x: sx, y: sy, z: BALL_R, dirY: -Math.sign(cy) * flip, ...BURST_GOAL });
    this.rings.spawn({ x: sx, y: sy, ...RING_GOAL });
    this.comboEl.style.opacity = "0"; // the rally is over

    if (won) {
      sfx.win(iScored);
      // Confetti rain from above center — pure flair on the match climax.
      this.particles.burst({ x: 0, y: 0, z: CONFETTI_Z, ...BURST_CONFETTI });
    } else {
      sfx.score(iScored);
    }
  }

  private wallFx(cx: number, cy: number): void {
    const flip = this.flip;
    this.squashBall("x");
    this.trauma = Math.min(1, this.trauma + TRAUMA_WALL);
    this.particles.burst({
      x: flip * cx,
      y: flip * cy,
      z: this.ballHeight(),
      dirX: -Math.sign(cx) * flip,
      ...BURST_WALL,
    });
    sfx.wall();
  }

  // ---- networking ----------------------------------------------------------

  /** Emit a host→guest fx beat, but only when a remote guest is listening
   *  (solo/offline replays fx locally, so there is no beat to loop back). */
  private emitBeat(event: string, payload: Record<string, unknown>): void {
    if (this.net.offline || !this.net.isHost || !this.hasOpponent()) return;
    this.net.sendEvent(event, payload);
  }

  private handleEvent(event: string, payload: unknown, _from: string): void {
    // Guest → host intent (serve / rematch). Only the host acts on it.
    if (event === "confirm") {
      if (!this.isGuest()) this.confirm();
      return;
    }
    // Host → guest fx beats — the host already ran these locally.
    if (!this.isGuest()) return;
    const p: Record<string, unknown> = {};
    if (payload && typeof payload === "object") Object.assign(p, payload);
    const num = (k: string): number => {
      const v = p[k];
      return typeof v === "number" ? v : 0;
    };
    const bool = (k: string): boolean => p[k] === true;
    switch (event) {
      case "phit":
        this.paddleHitFx(num("x"), num("y"), num("vx"), num("vy"), bool("a"), num("n"));
        break;
      case "wall":
        this.wallFx(num("x"), num("y"));
        break;
      case "point":
        this.pointFx(bool("a"), num("x"), num("y"), bool("won"));
        break;
      case "serve":
        this.comboEl.style.opacity = "0";
        sfx.serve();
        break;
    }
  }

  /** Host: broadcast the authoritative ball/score snapshot at ~NET_TICK_HZ. */
  private broadcastShared(dt: number): void {
    // Solo/alone: nobody reads shared state — don't stream ~30 msg/s at the
    // Durable Object for an empty room. (The first snapshot after a guest
    // joins goes out within one net tick.)
    if (this.net.offline || !this.hasOpponent()) return;
    this.netAcc += dt;
    if (this.netAcc < 1 / NET_TICK_HZ) return;
    this.netAcc = 0;
    this.hostSeq++;
    this.net.patchShared({
      seq: this.hostSeq,
      bx: this.ballPos.x,
      by: this.ballPos.y,
      bvx: this.ballVel.x,
      bvy: this.ballVel.y,
      phase: this.phase,
      rally: this.rallyHits,
      // Remaining time, not the absolute deadline: `serveAt` lives in OUR
      // `elapsed` timeline, which the guest's clock has no relation to.
      serveLeft: this.serveAt === null ? null : Math.max(0, this.serveAt - this.elapsed),
      scoreA: this.scoreYou,
      scoreB: this.scoreAi,
      arcFrom: this.arc ? this.arc.fromY : null,
      arcTo: this.arc ? this.arc.toY : null,
    });
  }

  /** Broadcast the local paddle position at ~NET_TICK_HZ (canonical frame). */
  private broadcastPaddle(dt: number): void {
    if (this.net.offline || !this.hasOpponent()) return;
    this.paddleAcc += dt;
    if (this.paddleAcc < 1 / NET_TICK_HZ) return;
    this.paddleAcc = 0;
    this.net.updateMyState({ paddle: this.myPaddle });
  }

  /** Guest: adopt the host's authoritative snapshot, dead-reckoning the ball
   *  between snapshots so it moves smoothly at the full frame rate. */
  private applyGuestShared(dt: number): void {
    const s = this.net.sharedState;
    if (!s) return;
    const seq = numField(s, "seq");
    const fresh = seq !== null && seq !== this.lastSeq;

    // Snapshot-derived state only changes when a new snapshot lands — adopt it
    // once per snapshot (not every frame; this also skips re-allocating the arc).
    if (fresh && seq !== null) {
      this.lastSeq = seq;
      this.ballVel.set(numField(s, "bvx") ?? 0, numField(s, "bvy") ?? 0);
      this.rallyHits = numField(s, "rally") ?? 0;
      // Re-anchor the host's remaining serve time in OUR timeline (only on a
      // fresh snapshot — re-anchoring stale data would freeze the meter).
      const sl = numField(s, "serveLeft");
      this.serveAt = sl === null ? null : this.elapsed + sl;

      // Slots A/B map to opponent/me for a guest.
      const prevYou = this.scoreYou;
      const prevAi = this.scoreAi;
      this.scoreYou = numField(s, "scoreB") ?? 0;
      this.scoreAi = numField(s, "scoreA") ?? 0;
      if (this.scoreYou !== prevYou) popScore(this.scoreYouEl);
      if (this.scoreAi !== prevAi) popScore(this.scoreAiEl);

      const af = numField(s, "arcFrom");
      const at = numField(s, "arcTo");
      this.arc = af !== null && at !== null ? { fromY: af, toY: at } : null;

      this.ballPos.set(numField(s, "bx") ?? 0, numField(s, "by") ?? 0);
    } else if (this.phase === "rally") {
      this.ballPos.addScaledVector(this.ballVel, dt);
    }

    const ph = s["phase"];
    const nextPhase: Phase = ph === "serving" || ph === "rally" || ph === "won" ? ph : this.phase;
    if (nextPhase !== this.phase || fresh) {
      this.phase = nextPhase;
      this.syncHud();
    }
  }

  // ---- visual effects ----------------------------------------------------------

  private squashBall(axis: "x" | "y" | "z"): void {
    const s = this.ball.scale;
    s.set(1 + SQUASH / 2, 1 + SQUASH / 2, 1 + SQUASH / 2);
    s[axis] = 1 - SQUASH;
  }

  private updateVisuals(dt: number): void {
    // A guest renders the canonical world flipped 180°, so its own paddle is at
    // the near (bottom) edge. `playerRing` is always the LOCAL paddle (bottom),
    // `aiRing` the opponent (top); both derive from the flipped canonical x.
    const flip = this.flip;
    this.playerPulse *= Math.exp(-PULSE_DECAY * dt);
    this.aiPulse *= Math.exp(-PULSE_DECAY * dt);
    this.playerRing.position.x = flip * this.myPaddle;
    this.playerRing.scale.setScalar(1 + PULSE_SCALE * this.playerPulse);
    this.aiRing.position.x = flip * this.oppPaddle;
    this.aiRing.scale.setScalar(1 + PULSE_SCALE * this.aiPulse);

    const arcZ = this.arc ? arcHeight(this.arc, this.ballPos.y) : 0;
    this.ball.position.set(flip * this.ballPos.x, flip * this.ballPos.y, BALL_R + arcZ);
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
          flip * (this.ballPos.x - this.ballVel.x * back),
          flip * (this.ballPos.y - this.ballVel.y * back),
          BALL_R + arcZ,
          ghostSize,
          ghostLife,
        );
      }
    }
    this.particles.update(dt);
    this.rings.update(dt);

    this.shadow.position.set(flip * this.ballPos.x, flip * this.ballPos.y, 0.01);
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
    const dipTarget = CAM_DIP_MAX * clamp(-(flip * this.ballPos.y) / GOAL_Y, 0, 1);
    this.camDip += (dipTarget - this.camDip) * (1 - Math.exp(-CAM_DIP_RATE * dt));
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    this.shakeTime += dt;

    // Camera-strafe drive: a smoothed, normalized −1..1 tracking the paddle x,
    // feeding the lateral camera strafe in composeCamera. Critically damped, in
    // its OWN field — never camDrag (which self-centers every frame).
    const parallaxTarget = (flip * this.myPaddle) / PADDLE_X_MAX;
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

  /** Start/serve instructions — the game is hand-gesture first, pointer second. */
  private servePromptText(): string {
    return COARSE_INPUT
      ? "✋ hand or finger steers · ✊ fist or tap serves"
      : "✋ hand or mouse steers · ✊ fist or click serves";
  }

  private syncHud(): void {
    this.scoreYouEl.textContent = String(this.scoreYou);
    this.scoreAiEl.textContent = String(this.scoreAi);
    const human = this.net.live && this.hasOpponent();
    this.oppLabelEl.textContent = human ? "RIVAL" : "AI";

    if (!this.net.live) {
      this.bannerEl.replaceChildren("connecting", smallNote("finding a match…"));
      this.bannerEl.style.opacity = "1";
    } else if (this.phase === "serving" && this.serveAt === null) {
      this.bannerEl.replaceChildren("PONG", smallNote(this.servePromptText()));
      this.bannerEl.style.opacity = "1";
    } else if (this.phase === "won") {
      const iWon = this.scoreYou > this.scoreAi;
      const strong = iWon ? "you win" : human ? "rival wins" : "ai wins";
      const note = COARSE_INPUT ? "✊ or tap for rematch" : "✊ or click for rematch";
      this.bannerEl.replaceChildren(strong, smallNote(note));
      this.bannerEl.style.opacity = "1";
    } else {
      this.bannerEl.style.opacity = "0";
    }
    this.netInfoEl.textContent = this.netInfoText();
  }

  private netInfoText(): string {
    if (!this.net.live) return "connecting…";
    if (this.net.offline) return "offline · vs AI";
    const role = this.isGuest() ? "guest" : "host";
    return this.hasOpponent() ? `${role} · 1v1` : `${role} · waiting for player`;
  }

  /** Surface the running rally length as an escalating "×N" once past MIN. */
  private showCombo(hits: number): void {
    if (hits < COMBO_MIN) return;
    const tier = clamp(hits / COMBO_PEAK_HITS, 0, 1);
    this.comboEl.textContent = `×${hits}`;
    this.comboEl.style.setProperty("--combo-tier", tier.toFixed(3));
    this.comboEl.style.opacity = "1";
    this.comboEl.classList.remove("pop");
    void this.comboEl.offsetWidth; // restart the CSS pop
    this.comboEl.classList.add("pop");
  }

  /** Deplete the serve-countdown bar over the auto-serve dead air between points. */
  private updateServeMeter(): void {
    const serveAt = this.serveAt;
    const active = this.phase === "serving" && serveAt !== null;
    if (active) {
      const left = Math.max(0, serveAt - this.elapsed);
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

/**
 * Vertical fov (deg) for the current aspect. Landscape keeps the authored
 * CAM_FOV; below CAM_MIN_LANDSCAPE_ASPECT the HORIZONTAL fov of that
 * narrowest-landscape framing is held constant instead ("Hor+"), so portrait
 * phones widen vertically rather than cropping the paddle's ±PADDLE_X_MAX
 * travel out of frame. Continuous at the threshold. The guest's 180° view
 * flip only negates rendered x/y — framing is symmetric, so no special case.
 */
function fovForAspect(aspect: number): number {
  if (aspect >= CAM_MIN_LANDSCAPE_ASPECT) return CAM_FOV;
  const tanHalfH = Math.tan(THREE.MathUtils.degToRad(CAM_FOV / 2)) * CAM_MIN_LANDSCAPE_ASPECT;
  return THREE.MathUtils.radToDeg(2 * Math.atan(tanHalfH / aspect));
}

/** Read a numeric field from an opaque shared-state record, or null. */
function numField(s: Record<string, unknown>, key: string): number | null {
  const v = s[key];
  return typeof v === "number" ? v : null;
}

/** Convert a legacy per-frame (60fps) lerp factor into a dt-correct one. */
function frameLerp(perFrame: number, dt: number): number {
  return 1 - Math.pow(1 - perFrame, dt * LEGACY_FPS);
}

/**
 * One step of a critically-damped spring toward `target` (Game Programming
 * Gems 4). Frame-rate independent; `omega` is the natural frequency (rad/s) —
 * higher snaps faster. Returns the new position and its carried velocity in a
 * shared scratch object (no per-frame allocation) — consume before calling again.
 */
const DAMP_OUT = { pos: 0, vel: 0 };
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
  DAMP_OUT.pos = target + (change + temp) * exp;
  DAMP_OUT.vel = (vel - omega * temp) * exp;
  return DAMP_OUT;
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
  // depthWrite off, like the shadow/ring overlays: the bars sit 0.004 above the
  // table and are usually invisible (opacity 0) — letting them write depth would
  // let the distance sort against the goal shockwave ring (spawned at the same
  // goal line, z 0.015) flip under camera breath/shake and flicker through the
  // dither pass.
  return new THREE.MeshBasicMaterial({
    color: INK,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
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
