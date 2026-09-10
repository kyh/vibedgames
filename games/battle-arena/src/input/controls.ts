// Desktop FPS-style input: the pointer is LOCKED and the crosshair sits dead
// center. Moving the mouse turns the heading (yaw) and tilts the view (pitch);
// the character faces the crosshair, camera stays behind. W=forward, S=back,
// A/D=strafe relative to facing; LMB=attack (airborne LMB casts JUMP), Space=hop,
// Shift=cast DASH; 1/2/3/4 cast the kit, 5-0 the item belt.
// A physical gamepad folds into the same fields (update() each frame): left
// stick=move, right stick=look, RT=attack (airborne edge casts JUMP), A=hop,
// B=dash, X/Y/LB/RB=abilities, SELECT=shop, START held=scoreboard.
import { PhysicalGamepad } from "@vibedgames/gamepad";
import type { AbilityKey } from "../sim/types";

// radians of look per pixel of mouse movement
const MOUSE_SENS = 0.0028;
// look down
const PITCH_MIN = -1;
// look up
const PITCH_MAX = 0.7;
// right-stick look rate at full deflection: ~180°/s of turn feels like the
// 0.0028 rad/px mouse at a comfortable sweep; pitch runs at half rate because
// its whole travel is only 1.7 rad
// rad/s
const PAD_YAW_SPEED = Math.PI;
// rad/s
const PAD_PITCH_SPEED = Math.PI / 2;

const ABILITY_BY_CODE = new Map<string, AbilityKey>([
  ["Digit1", "Q"],
  ["Numpad1", "Q"],
  ["Digit2", "W"],
  ["Numpad2", "W"],
  ["Digit3", "E"],
  ["Numpad3", "E"],
  ["Digit4", "R"],
  ["Numpad4", "R"],
]);

const ITEM_BY_CODE = new Map<string, number>([
  ["Digit5", 0],
  ["Digit6", 1],
  ["Digit7", 2],
  ["Digit8", 3],
  ["Digit9", 4],
  ["Digit0", 5],
]);

const swallowEvent = (e: Event): void => e.preventDefault();

export class Controls {
  private keys = new Set<string>();
  private abilityQueue: AbilityKey[] = [];
  // item-belt slot indices
  private itemQueue: number[] = [];
  private buyPressed = false;
  private guidePressed = false;
  private scorePressed = false;
  // Space edge (hop)
  private jumpPressed = false;
  // Shift edge (cast DASH)
  private dashPressed = false;
  // heading; aim = (sin yaw, cos yaw) on the ground plane
  private yaw = 0;
  // view tilt (camera only; >0 looks up)
  private pitch = 0;
  private lmb = false;
  // LMB press edge — an airborne click casts JUMP
  private lmbEdge = false;
  private hadInput = false;
  // physical gamepad — polled by update(), folded into the same fields the
  // keyboard/mouse listeners write so every read path stays single-source
  private pad = new PhysicalGamepad();
  private padFwd = 0;
  private padStrafe = 0;
  // RT held (mirrors this.lmb)
  private padAttack = false;
  // MOUSE MODE: menus need a free cursor (shop, end screen). While on, the
  // pointer stays unlocked, mouse motion doesn't steer, and clicks are UI —
  // never attacks. ACTION MODE (default) is the FPS-style locked pointer.
  private uiMode = false;

  private canvas: HTMLElement;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("contextmenu", swallowEvent);
  }

  /** Whether the pointer is currently locked to the canvas. */
  private get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** Request pointer lock (call from a user gesture). Safe if already locked.
   *  Newer browsers return a Promise that rejects when the request is invalid
   *  (e.g. not a trusted gesture, or an embedded document) — swallow both the
   *  sync throw and the async rejection so it never surfaces as an error. */
  lockPointer(): void {
    if (this.locked || this.uiMode) {
      return;
    }
    void this.requestLock();
  }

  private async requestLock(): Promise<void> {
    try {
      await this.canvas.requestPointerLock();
    } catch {
      /* unsupported — fall back to free mouse */
    }
  }

  /** Flip between MOUSE mode (free cursor for menus) and ACTION mode.
   *  Turning action mode back on attempts an immediate relock — valid while the
   *  triggering gesture's transient activation lasts; if the browser refuses,
   *  the next canvas click relocks (the familiar FPS pattern). */
  setMouseMode(on: boolean): void {
    if (this.uiMode === on) {
      return;
    }
    this.uiMode = on;
    document.body.classList.toggle("ba-mouse-mode", on);
    if (on) {
      // an in-flight attack hold must not survive into a menu
      this.lmb = false;
      this.lmbEdge = false;
      if (this.locked) {
        document.exitPointerLock();
      }
    } else {
      this.lockPointer();
    }
  }

  get inMouseMode(): boolean {
    return this.uiMode;
  }

  /** Touch look stick: fold a deflection (unit-clamped, y-down screen axes)
   *  into yaw/pitch at the same rates as the physical pad's right stick.
   *  MOUSE-mode guarded like every other look path (menus own the pointer). */
  applyStickLook(dx: number, dy: number, dt: number): void {
    if (this.uiMode || (dx === 0 && dy === 0)) {
      return;
    }
    this.yaw -= dx * dt * PAD_YAW_SPEED;
    this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch - dy * dt * PAD_PITCH_SPEED));
    this.hadInput = true;
  }

  /** Poll the physical gamepad and fold it into the keyboard/mouse fields.
   *  Call once per frame, before the frame's reads (works without pointer
   *  lock — pad look integrates yaw/pitch directly, dt-scaled). */
  update(dt: number): void {
    this.pad.update();
    this.padFwd = 0;
    this.padStrafe = 0;
    this.padAttack = false;
    if (!this.pad.connected) {
      return;
    }

    // left stick → the same forward/strafe axes WASD produces; dead-zoned
    // radial response, analog direction carries through (the scene normalizes)
    const move = this.pad.getStick("left");
    if (!move.inDeadZone && move.distance > 0) {
      const scale = move.magnitude / move.distance;
      this.padStrafe = move.dx * scale;
      // stick axes are y-down; up = forward
      this.padFwd = -move.dy * scale;
      this.hadInput = true;
    }

    // look + attack mirror the mouse, including its MOUSE-mode guard (menus
    // own the cursor — pad steering/attacks must not fight the shop)
    if (!this.uiMode) {
      const look = this.pad.getStick("right");
      if (!look.inDeadZone && look.distance > 0) {
        const scale = (look.magnitude / look.distance) * dt;
        // stick right = turn right
        this.yaw -= look.dx * scale * PAD_YAW_SPEED;
        this.pitch = Math.max(
          PITCH_MIN,
          Math.min(PITCH_MAX, this.pitch - look.dy * scale * PAD_PITCH_SPEED),
        );
        this.hadInput = true;
      }
      // RT mirrors LMB exactly: held = basic attack, press edge = airborne JUMP
      this.padAttack = this.pad.isButtonDown("rt");
      if (this.pad.justPressed("rt")) {
        this.lmbEdge = true;
        this.hadInput = true;
      }
    }

    // buttons queue like keydowns — live in MOUSE mode too (keys are today;
    // SELECT especially must still close an open shop)
    if (this.pad.justPressed("a")) {
      this.jumpPressed = true;
    }
    if (this.pad.justPressed("b")) {
      this.dashPressed = true;
    }
    if (this.pad.justPressed("x")) {
      this.abilityQueue.push("Q");
    }
    if (this.pad.justPressed("y")) {
      this.abilityQueue.push("W");
    }
    if (this.pad.justPressed("lb")) {
      this.abilityQueue.push("E");
    }
    if (this.pad.justPressed("rb")) {
      this.abilityQueue.push("R");
    }
    if (this.pad.justPressed("select")) {
      this.buyPressed = true;
    }
    if (this.pad.justPressed("ls")) {
      this.guidePressed = true;
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) {
      return;
    }
    const { code } = e;
    this.keys.add(code);
    this.hadInput = true;
    const ability = ABILITY_BY_CODE.get(code);
    const item = ITEM_BY_CODE.get(code);
    if (ability) {
      this.abilityQueue.push(ability);
    } else if (item !== undefined) {
      this.itemQueue.push(item);
    } else if (code === "KeyB") {
      this.buyPressed = true;
    } else if (code === "KeyH") {
      this.guidePressed = true;
    } else if (code === "Space") {
      this.jumpPressed = true;
      // don't scroll the page
      e.preventDefault();
    } else if (code === "ShiftLeft" || code === "ShiftRight") {
      this.dashPressed = true;
    } else if (code === "Tab") {
      this.scorePressed = true;
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.uiMode) {
      return;
      // free cursor is browsing menus, not steering
    }
    // turn/tilt by relative motion (works locked or not); crosshair stays
    // centered. mouse-right turns the view right → decrease yaw; mouse-up
    // looks up → increase pitch.
    this.yaw -= e.movementX * MOUSE_SENS;
    this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch - e.movementY * MOUSE_SENS));
    this.hadInput = true;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (this.uiMode) {
      return;
      // clicks belong to the menu UI
    }
    // first click grabs the pointer; later clicks just act
    this.lockPointer();
    if (e.button === 0) {
      this.lmb = true;
      this.lmbEdge = true;
      this.hadInput = true;
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.lmb = false;
    }
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.lmb = false;
    this.lmbEdge = false;
  };

  /** Camera-relative move axes: forward (+W/-S), strafe (+D/-A). The scene
   *  composes these with the facing direction. */
  moveAxes() {
    let fwd = this.padFwd;
    let strafe = this.padStrafe;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) {
      fwd += 1;
    }
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) {
      fwd -= 1;
    }
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) {
      strafe += 1;
    }
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) {
      strafe -= 1;
    }
    return { fwd, strafe };
  }

  /** Current heading (radians). aim = (sin yaw, cos yaw) on the ground plane. */
  aimYaw(): number {
    return this.yaw;
  }

  /** Current view tilt (radians; >0 looks up). Camera-only — aim stays planar. */
  aimPitch(): number {
    return this.pitch;
  }

  /** Seed the heading once (e.g. to the hero's spawn facing) so the view
   *  doesn't snap on the first frame. */
  setYaw(y: number): void {
    this.yaw = y;
  }

  attackDown(): boolean {
    return this.lmb || this.padAttack;
  }

  /** Edge-triggered LMB press. Distinguishes an airborne click (→ JUMP ability)
   *  from the held basic attack; drained every frame so a grounded click never
   *  lingers to fire a jump-strike on the next hop. */
  consumeAttackEdge(): boolean {
    const e = this.lmbEdge;
    this.lmbEdge = false;
    return e;
  }

  /** Edge-triggered Shift (cast the hero's DASH ability). */
  consumeDash(): boolean {
    const d = this.dashPressed;
    this.dashPressed = false;
    return d;
  }

  /** Drain queued ability presses (edge-triggered). */
  consumeAbilities(): AbilityKey[] {
    const out = this.abilityQueue;
    this.abilityQueue = [];
    return out;
  }

  /** Drain queued item-belt presses (slot indices). */
  consumeItems(): number[] {
    const out = this.itemQueue;
    this.itemQueue = [];
    return out;
  }

  consumeBuy(): boolean {
    const b = this.buyPressed;
    this.buyPressed = false;
    return b;
  }

  /** Edge-triggered Space (jump/hop). */
  consumeJump(): boolean {
    const j = this.jumpPressed;
    this.jumpPressed = false;
    return j;
  }

  scoreHeld(): boolean {
    return this.keys.has("Tab") || this.pad.isButtonDown("start");
  }

  consumedAnyInput(): boolean {
    return this.hadInput;
  }

  consumeGuide(): boolean {
    const pressed = this.guidePressed;
    this.guidePressed = false;
    return pressed;
  }

  /** Release remembered input at pause/transport boundaries. Sample both pad
   * buffers so a held button cannot become a fresh press after resuming. */
  resetInput(): void {
    this.keys.clear();
    this.abilityQueue = [];
    this.itemQueue = [];
    this.buyPressed = false;
    this.guidePressed = false;
    this.scorePressed = false;
    this.jumpPressed = false;
    this.dashPressed = false;
    this.lmb = false;
    this.lmbEdge = false;
    this.padFwd = 0;
    this.padStrafe = 0;
    this.padAttack = false;
    this.pad.update();
    this.pad.update();
  }

  dispose(): void {
    this.pad.destroy();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("contextmenu", swallowEvent);
  }
}
