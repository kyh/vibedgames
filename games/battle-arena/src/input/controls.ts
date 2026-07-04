// Desktop FPS-style input: the pointer is LOCKED and the crosshair sits dead
// center. Moving the mouse turns the heading (yaw) and tilts the view (pitch);
// the character faces the crosshair, camera stays behind. W=forward, S=back,
// A/D=strafe relative to facing; LMB=attack (airborne LMB casts JUMP), Space=hop,
// Shift=cast DASH; 1/2/3/4 cast the kit, 5-0 the item belt.
import type { AbilityKey } from "../sim/types";

const MOUSE_SENS = 0.0028; // radians of look per pixel of mouse movement
const PITCH_MIN = -1.0; // look down
const PITCH_MAX = 0.7; // look up

export class Controls {
  private keys = new Set<string>();
  private abilityQueue: AbilityKey[] = [];
  private itemQueue: number[] = []; // item-belt slot indices
  private buyPressed = false;
  private scorePressed = false;
  private jumpPressed = false; // Space edge (hop)
  private dashPressed = false; // Shift edge (cast DASH)
  private yaw = 0; // heading; aim = (sin yaw, cos yaw) on the ground plane
  private pitch = 0; // view tilt (camera only; >0 looks up)
  private lmb = false;
  private lmbEdge = false; // LMB press edge — an airborne click casts JUMP
  private hadInput = false;
  // MOUSE MODE: menus need a free cursor (shop, end screen). While on, the
  // pointer stays unlocked, mouse motion doesn't steer, and clicks are UI —
  // never attacks. ACTION MODE (default) is the FPS-style locked pointer.
  private uiMode = false;

  constructor(private canvas: HTMLElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("contextmenu", this.onContext);
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
    if (this.locked || this.uiMode) return;
    try {
      Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
    } catch {
      /* unsupported — fall back to free mouse */
    }
  }

  /** Flip between MOUSE mode (free cursor for menus) and ACTION mode.
   *  Turning action mode back on attempts an immediate relock — valid while the
   *  triggering gesture's transient activation lasts; if the browser refuses,
   *  the next canvas click relocks (the familiar FPS pattern). */
  setMouseMode(on: boolean): void {
    if (this.uiMode === on) return;
    this.uiMode = on;
    document.body.classList.toggle("ba-mouse-mode", on);
    if (on) {
      this.lmb = false; // an in-flight attack hold must not survive into a menu
      this.lmbEdge = false;
      if (this.locked) document.exitPointerLock();
    } else {
      this.lockPointer();
    }
  }

  get inMouseMode(): boolean {
    return this.uiMode;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const code = e.code;
    this.keys.add(code);
    this.hadInput = true;
    if (code === "Digit1" || code === "Numpad1") this.abilityQueue.push("Q");
    else if (code === "Digit2" || code === "Numpad2") this.abilityQueue.push("W");
    else if (code === "Digit3" || code === "Numpad3") this.abilityQueue.push("E");
    else if (code === "Digit4" || code === "Numpad4") this.abilityQueue.push("R");
    else if (code === "Digit5") this.itemQueue.push(0);
    else if (code === "Digit6") this.itemQueue.push(1);
    else if (code === "Digit7") this.itemQueue.push(2);
    else if (code === "Digit8") this.itemQueue.push(3);
    else if (code === "Digit9") this.itemQueue.push(4);
    else if (code === "Digit0") this.itemQueue.push(5);
    else if (code === "KeyB") this.buyPressed = true;
    else if (code === "Space") {
      this.jumpPressed = true;
      e.preventDefault(); // don't scroll the page
    } else if (code === "ShiftLeft" || code === "ShiftRight") this.dashPressed = true;
    else if (code === "Tab") {
      this.scorePressed = true;
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.uiMode) return; // free cursor is browsing menus, not steering
    // turn/tilt by relative motion (works locked or not); crosshair stays
    // centered. mouse-right turns the view right → decrease yaw; mouse-up
    // looks up → increase pitch.
    this.yaw -= e.movementX * MOUSE_SENS;
    this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch - e.movementY * MOUSE_SENS));
    this.hadInput = true;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (this.uiMode) return; // clicks belong to the menu UI
    this.lockPointer(); // first click grabs the pointer; later clicks just act
    if (e.button === 0) {
      this.lmb = true;
      this.lmbEdge = true;
      this.hadInput = true;
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.lmb = false;
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.lmb = false;
    this.lmbEdge = false;
  };

  private onContext = (e: Event): void => e.preventDefault();

  /** Camera-relative move axes: forward (+W/-S), strafe (+D/-A). The scene
   *  composes these with the facing direction. */
  moveAxes(): { fwd: number; strafe: number } {
    let fwd = 0;
    let strafe = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) fwd += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) fwd -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) strafe += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) strafe -= 1;
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
    return this.lmb;
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
    return this.keys.has("Tab");
  }

  consumedAnyInput(): boolean {
    return this.hadInput;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("contextmenu", this.onContext);
  }
}
