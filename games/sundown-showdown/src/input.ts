// Keyboard + mouse and touch input. On touch the screen is split into two
// virtual sticks (left 45% moves, the rest aims) plus the on-screen super
// button; dragging a stick past the dead zone and releasing fires in that
// direction, a plain tap fires with auto-aim, and pulling back inside the dead
// zone cancels. Touch and mouse are told apart by a short grace window after
// the last touch, so a phone with a mouse attached does not flip modes on
// every synthetic mouse event.

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
const STICK_DEAD_ZONE = 0.22;
/** Touches left of this fraction of the screen grab the move stick. */
const MOVE_ZONE_FRACTION = 0.45;
/** Mouse events this soon after a touch are the browser's synthetic ones. */
const TOUCH_GRACE_MS = 900;

const SUPER_KEYS = new Set(["Space", "KeyE"]);

const isFormField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "SELECT");

export class Input {
  keys = new Set<string>();
  ndcX = 0;
  ndcY = 0;
  fire = false;
  superHeld = false;
  superReleased = false;
  enabled = true;
  touchMode = false;
  onTouchMode: ((on: boolean) => void) | null = null;
  lastTouch = -1e9;
  sticks: Sticks = { aim: makeStick(), move: makeStick(), super: makeStick() };
  shots: Shot[] = [];

  constructor(canvas: HTMLElement, superButton: HTMLElement | null) {
    this.bindKeyboard();
    this.bindMouse(canvas);
    this.bindTouch(canvas, superButton);
  }

  private recentTouch(): boolean {
    return performance.now() - this.lastTouch < TOUCH_GRACE_MS;
  }

  private setPointer(e: MouseEvent): void {
    this.ndcX = (e.clientX / window.innerWidth) * 2 - 1;
    this.ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", (e) => {
      if (e.repeat || isFormField(e.target)) {
        return;
      }
      const code = keyCode(e);
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
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.fire = false;
      this.superHeld = false;
      for (const stick of Object.values(this.sticks)) {
        resetStick(stick);
      }
    });
  }

  private bindMouse(canvas: HTMLElement): void {
    window.addEventListener("mousemove", (e) => {
      if (!this.recentTouch()) {
        this.setPointer(e);
      }
    });
    canvas.addEventListener("mousedown", (e) => {
      if (this.recentTouch()) {
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
        if (!this.recentTouch()) {
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
    if (e.pointerType !== "touch") {
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

  /** Movement direction, unit length or zero: the move stick when held, else WASD/arrows. */
  axis(): Axis {
    const { move } = this.sticks;
    if (move.id !== null && move.mag > STICK_DEAD_ZONE) {
      const len = Math.hypot(move.x, move.y) || 1;
      return { x: move.x / len, z: move.y / len };
    }
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
    return len > 0 ? { x: x / len, z: z / len } : { x: 0, z: 0 };
  }

  /** True once per release of the super key / right mouse button. */
  consumeSuperRelease(): boolean {
    const released = this.superReleased;
    this.superReleased = false;
    return released;
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
