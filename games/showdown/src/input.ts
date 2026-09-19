// Keyboard + mouse and touch input. On touch the screen is split into two
// virtual sticks (left 45% moves, the rest aims) plus the on-screen super
// button; dragging a stick past the dead zone and releasing fires in that
// direction, a plain tap fires with auto-aim, and pulling back inside the dead
// zone cancels. Touch and mouse are told apart by a short grace window after
// the last touch, so a phone with a mouse attached does not flip modes on
// every synthetic mouse event. A physical gamepad folds into the same fields
// the keyboard and mouse write (poll() once per frame): left stick moves,
// right stick aims, RT/A fire like the left mouse button, LT/RB hold-and-
// release the super like Space, START opens the shared Escape pause overlay.

import { PhysicalGamepad } from "@vibedgames/gamepad";
import type { StickState } from "@vibedgames/gamepad";

export { isPadConnected } from "@vibedgames/gamepad";

export interface Stick {
  /** Pointer id currently holding this stick, or null when idle. */
  id: number | null;
  /** Deflection length, 0–1. */
  mag: number;
  /** True once the stick has been dragged past the dead zone. */
  moved: boolean;
  /** Screen position where the touch started (the stick's centre). */
  ox: number;
  oy: number;
  /** Deflection, each axis -1..1 in screen space (y grows downward). */
  x: number;
  y: number;
}

export type ShotKind = "attack" | "super";

export interface Shot {
  /** Dragged, then released back inside the dead zone: fire nothing. */
  cancelled: boolean;
  kind: ShotKind;
  mag: number;
  /** Released without dragging: the game auto-aims. */
  tap: boolean;
  x: number;
  y: number;
}

export interface Sticks {
  aim: Stick;
  move: Stick;
  super: Stick;
}

export interface Axis {
  x: number;
  z: number;
}

/** Physical key codes for browsers that only report `key`. */
const FALLBACK_KEY_CODES = new Map<string, string>([
  [" ", "Space"],
  ["a", "KeyA"],
  ["arrowdown", "ArrowDown"],
  ["arrowleft", "ArrowLeft"],
  ["arrowright", "ArrowRight"],
  ["arrowup", "ArrowUp"],
  ["d", "KeyD"],
  ["e", "KeyE"],
  ["escape", "Escape"],
  ["m", "KeyM"],
  ["p", "KeyP"],
  ["s", "KeyS"],
  ["shift", "ShiftLeft"],
  ["spacebar", "Space"],
  ["t", "KeyT"],
  ["w", "KeyW"],
]);

export const keyCode = (e: KeyboardEvent): string =>
  e.code || FALLBACK_KEY_CODES.get((e.key || "").toLowerCase()) || "";

export const makeStick = (): Stick => ({
  id: null,
  mag: 0,
  moved: false,
  ox: 0,
  oy: 0,
  x: 0,
  y: 0,
});

const resetStick = (stick: Stick): void => {
  stick.id = null;
  stick.x = 0;
  stick.y = 0;
  stick.mag = 0;
  stick.moved = false;
};

/** Pixels of drag for a full deflection. */
const STICK_RADIUS_PX = 58;
export const STICK_DEAD_ZONE = 0.22;
/** Touches left of this fraction of the screen grab the move stick. */
const MOVE_ZONE_FRACTION = 0.45;
/** Mouse events this soon after a touch are the browser's synthetic ones. */
const TOUCH_GRACE_MS = 900;

const SUPER_KEYS = new Set(["Space", "KeyE"]);
const EVADE_KEYS = new Set(["ShiftLeft", "ShiftRight"]);

/** Pad actions → buttons. Raw names stay readable through the same API. */
const PAD_BINDINGS = {
  evade: ["b", "lb"],
  fire: ["rt", "a"],
  pause: ["start"],
  super: ["lt", "rb"],
} as const;

/** A pad stick as a unit direction (right = +x, down = +z), or null inside the dead zone. */
const stickDirection = (stick: StickState): Axis | null => {
  if (!stick.active || stick.inDeadZone || stick.distance === 0) {
    return null;
  }
  return { x: stick.dx / stick.distance, z: stick.dy / stick.distance };
};

/** Any pad input a player would notice: a fresh button or a deflected stick. */
const padTouched = (pad: PhysicalGamepad): boolean =>
  Object.keys(PAD_BINDINGS).some((action) => pad.justPressed(action)) ||
  !pad.getStick("left").inDeadZone ||
  !pad.getStick("right").inDeadZone;

export const isFormField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" ||
    target.tagName === "SELECT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable);

export class Input {
  keys = new Set<string>();
  ndcX = 0;
  ndcY = 0;
  fire = false;
  superHeld = false;
  superReleased = false;
  private evadePressed = false;
  enabled = true;
  touchMode = false;
  aimMethod: "pointer" | "pad" = "pointer";
  onTouchMode: ((on: boolean) => void) | null = null;
  lastTouch = -1e9;
  sticks: Sticks = { aim: makeStick(), move: makeStick(), super: makeStick() };
  shots: Shot[] = [];
  private readonly pad = new PhysicalGamepad({ bindings: PAD_BINDINGS });
  /** Set once the host calls poll(); until then axis() polls on demand. */
  private hostPolls = false;

  constructor(
    canvas: HTMLElement,
    superButton: HTMLElement | null,
    evadeButton: HTMLElement | null = null,
  ) {
    this.bindKeyboard();
    this.bindMouse(canvas);
    this.bindTouch(canvas, superButton);
    this.bindEvadeButton(evadeButton);
  }

  private clear(): void {
    this.keys.clear();
    this.fire = false;
    this.superHeld = false;
    this.superReleased = false;
    this.evadePressed = false;
    this.shots.length = 0;
    for (const stick of Object.values(this.sticks)) {
      resetStick(stick);
    }
  }

  /** Overlay events may swallow releases; neither side of a pause carries input. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.clear();
    // Baseline held buttons so the press that resumes cannot also attack.
    this.pad.update();
    this.pad.update();
  }

  private recentTouch(): boolean {
    return performance.now() - this.lastTouch < TOUCH_GRACE_MS;
  }

  private setPointer(e: MouseEvent): void {
    this.aimMethod = "pointer";
    this.ndcX = (e.clientX / window.innerWidth) * 2 - 1;
    this.ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", (e) => {
      if (!this.enabled || e.repeat || isFormField(e.target)) {
        return;
      }
      const code = keyCode(e);
      if (EVADE_KEYS.has(code) && !this.keys.has(code)) {
        this.evadePressed = true;
        e.preventDefault();
      }
      this.keys.add(code);
      if (SUPER_KEYS.has(code)) {
        this.superHeld = true;
        e.preventDefault();
      }
      if (code.startsWith("Arrow")) {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      const code = keyCode(e);
      this.keys.delete(code);
      if (SUPER_KEYS.has(code) && this.superHeld) {
        this.superHeld = false;
        this.superReleased = true;
      }
    });
    window.addEventListener("blur", () => this.clear());
  }

  private bindEvadeButton(button: HTMLElement | null): void {
    button?.addEventListener("pointerdown", (e) => {
      if (!this.enabled || e.pointerType !== "touch") {
        return;
      }
      this.lastTouch = performance.now();
      this.setTouchMode(true);
      this.evadePressed = true;
      e.preventDefault();
    });
    button?.addEventListener("click", () => {
      if (this.enabled && !this.recentTouch()) {
        this.evadePressed = true;
      }
    });
  }

  private bindMouse(canvas: HTMLElement): void {
    window.addEventListener("mousemove", (e) => {
      if (this.enabled && !this.recentTouch()) {
        this.setTouchMode(false);
        this.setPointer(e);
      }
    });
    canvas.addEventListener("mousedown", (e) => {
      if (!this.enabled || this.recentTouch()) {
        return;
      }
      if (this.touchMode) {
        this.setTouchMode(false);
      }
      this.setPointer(e);
      if (e.button === 0) {
        this.fire = true;
      }
      if (e.button === 2) {
        this.superHeld = true;
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) {
        this.fire = false;
      }
      if (e.button === 2 && this.superHeld) {
        this.superHeld = false;
        this.superReleased = true;
      }
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private bindTouch(canvas: HTMLElement, superButton: HTMLElement | null): void {
    canvas.addEventListener("pointerdown", (e) => this.beginTouch(e, "field"));
    if (superButton) {
      superButton.addEventListener("pointerdown", (e) => this.beginTouch(e, "super"));
      superButton.addEventListener("click", () => {
        if (this.enabled && !this.recentTouch()) {
          this.shots.push({ cancelled: false, kind: "super", mag: 0, tap: true, x: 0, y: 0 });
        }
      });
    }
    window.addEventListener("pointermove", (e) => this.moveTouch(e));
    const release = (e: PointerEvent) => this.endTouch(e);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  }

  private stickForTouch(e: PointerEvent, zone: "field" | "super"): Stick {
    if (zone === "super") {
      return this.sticks.super;
    }
    return e.clientX < window.innerWidth * MOVE_ZONE_FRACTION ? this.sticks.move : this.sticks.aim;
  }

  private stickHeldBy(e: PointerEvent): Stick | undefined {
    return Object.values(this.sticks).find((stick) => stick.id === e.pointerId);
  }

  private beginTouch(e: PointerEvent, zone: "field" | "super"): void {
    if (!this.enabled || e.pointerType !== "touch") {
      return;
    }
    this.lastTouch = performance.now();
    if (!this.touchMode) {
      this.setTouchMode(true);
    }
    const stick = this.stickForTouch(e, zone);
    if (stick.id !== null) {
      return;
    }
    stick.id = e.pointerId;
    stick.ox = e.clientX;
    stick.oy = e.clientY;
    stick.x = 0;
    stick.y = 0;
    stick.mag = 0;
    stick.moved = false;
    e.preventDefault();
  }

  private moveTouch(e: PointerEvent): void {
    if (e.pointerType !== "touch") {
      return;
    }
    this.lastTouch = performance.now();
    const stick = this.stickHeldBy(e);
    if (!stick) {
      return;
    }
    let dx = (e.clientX - stick.ox) / STICK_RADIUS_PX;
    let dy = (e.clientY - stick.oy) / STICK_RADIUS_PX;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    stick.x = dx;
    stick.y = dy;
    stick.mag = Math.min(1, len);
    if (stick.mag > STICK_DEAD_ZONE) {
      stick.moved = true;
    }
  }

  private endTouch(e: PointerEvent): void {
    if (e.pointerType !== "touch") {
      return;
    }
    this.lastTouch = performance.now();
    const stick = this.stickHeldBy(e);
    if (!stick) {
      return;
    }
    if (stick !== this.sticks.move && e.type === "pointerup") {
      this.shots.push({
        cancelled: stick.moved && stick.mag <= STICK_DEAD_ZONE,
        kind: stick === this.sticks.super ? "super" : "attack",
        mag: stick.mag,
        tap: !stick.moved,
        x: stick.x,
        y: stick.y,
      });
    }
    resetStick(stick);
  }

  setTouchMode(on: boolean): void {
    if (this.touchMode === on) {
      return;
    }
    this.touchMode = on;
    this.fire = false;
    if (!on) {
      for (const stick of Object.values(this.sticks)) {
        resetStick(stick);
      }
    }
    this.onTouchMode?.(on);
  }

  /**
   * Poll the physical gamepad and fold it into the keyboard/mouse fields.
   * Game must call this once per frame, before the paused early-return and
   * before any input read, so a START press still toggles pause while the
   * sim is frozen. Until Game does, axis() polls on demand.
   */
  poll(): void {
    this.hostPolls = true;
    this.pollPad();
  }

  private pollPad(): void {
    const { pad } = this;
    pad.update();
    if (!pad.connected || !this.enabled) {
      return;
    }
    if (pad.justPressed("pause")) {
      return;
    }
    // A pad in hand means the thumb sticks are not: same switch a mouse click makes.
    if (padTouched(pad)) {
      this.aimMethod = "pad";
      this.setTouchMode(false);
    }
    // RT / A are the left mouse button.
    if (pad.justPressed("fire")) {
      this.fire = true;
    }
    if (pad.justReleased("fire")) {
      this.fire = false;
    }
    // LT / RB are Space: hold to aim the super, release to fire it.
    if (pad.justPressed("super")) {
      this.superHeld = true;
    }
    if (pad.justReleased("super") && this.superHeld) {
      this.superHeld = false;
      this.superReleased = true;
    }
    if (pad.justPressed("evade")) {
      this.evadePressed = true;
    }
  }

  /**
   * Right stick as a unit world direction, in the axes mouse aim uses (stick
   * right = +x, stick down = +z), or null inside the dead zone / with no pad.
   */
  padAim(): Axis | null {
    return this.enabled ? stickDirection(this.pad.getStick("right")) : null;
  }

  padAimHeld(): boolean {
    return this.padAim() !== null;
  }

  /** Press edge of a pad button or d-pad direction by its raw name (`"a"`, `"start"`, `"left"`…). */
  padJustPressed(button: string): boolean {
    return this.enabled && this.pad.connected && this.pad.justPressed(button);
  }

  /** Left-stick deflection past the dead zone, for menu navigation edges. */
  padStick(): Axis | null {
    return this.enabled ? stickDirection(this.pad.getStick("left")) : null;
  }

  /** WASD / arrows as a unit direction, or null when none is held. */
  private keyAxis(): Axis | null {
    const { keys } = this;
    let x = 0;
    let z = 0;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) {
      x -= 1;
    }
    if (keys.has("KeyD") || keys.has("ArrowRight")) {
      x += 1;
    }
    if (keys.has("KeyW") || keys.has("ArrowUp")) {
      z -= 1;
    }
    if (keys.has("KeyS") || keys.has("ArrowDown")) {
      z += 1;
    }
    const len = Math.hypot(x, z);
    return len > 0 ? { x: x / len, z: z / len } : null;
  }

  /**
   * Movement direction, unit length or zero: the touch move stick when held,
   * else WASD/arrows, else the pad's left stick.
   */
  axis(): Axis {
    if (!this.enabled) {
      return { x: 0, z: 0 };
    }
    if (!this.hostPolls) {
      this.pollPad();
    }
    const { move } = this.sticks;
    if (move.id !== null && move.mag > STICK_DEAD_ZONE) {
      const len = Math.hypot(move.x, move.y) || 1;
      return { x: move.x / len, z: move.y / len };
    }
    return this.keyAxis() ?? stickDirection(this.pad.getStick("left")) ?? { x: 0, z: 0 };
  }

  /** True once per release of the super key / right mouse button. */
  consumeSuperRelease(): boolean {
    const released = this.superReleased;
    this.superReleased = false;
    return released;
  }

  /** A press starts one evade; holding a key never repeats it. */
  consumeEvade(): boolean {
    const pressed = this.evadePressed;
    this.evadePressed = false;
    return pressed;
  }

  /** Drains the touch shots queued since the last call. */
  takeShots(): Shot[] {
    if (this.shots.length === 0) {
      return this.shots;
    }
    const { shots } = this;
    this.shots = [];
    return shots;
  }
}
