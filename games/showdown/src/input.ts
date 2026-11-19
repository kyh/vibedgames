import { PhysicalGamepad } from "@vibedgames/gamepad";
import type { StickState } from "@vibedgames/gamepad";

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

export const keyCode = (e: KeyboardEvent) =>
  e.code || FALLBACK_KEY_CODES.get((e.key || "").toLowerCase()) || "";

const makeStick: () => Stick = () => ({
  id: null,
  mag: 0,
  moved: false,
  ox: 0,
  oy: 0,
  x: 0,
  y: 0,
});

const resetStick = (stick: Stick) => {
  stick.id = null;
  stick.x = 0;
  stick.y = 0;
  stick.mag = 0;
  stick.moved = false;
};

const STICK_RADIUS_PX = 58;
export const STICK_DEAD_ZONE = 0.22;
const MOVE_ZONE_FRACTION = 0.45;
const TOUCH_GRACE_MS = 900;

const SUPER_KEYS = new Set(["Space", "KeyE"]);
const EVADE_KEYS = new Set(["ShiftLeft", "ShiftRight"]);

const PAD_BINDINGS = {
  evade: ["b", "lb"],
  fire: ["rt", "a"],
  pause: ["start"],
  super: ["lt", "rb"],
} as const;

const PAD_ACTIONS = Object.keys(PAD_BINDINGS);

const stickDirection = (stick: StickState) => {
  if (!stick.active || stick.inDeadZone || stick.distance === 0) {
    return null;
  }

  return { x: stick.dx / stick.distance, z: stick.dy / stick.distance };
};

const padTouched = (pad: PhysicalGamepad) =>
  PAD_ACTIONS.some((action) => pad.justPressed(action)) ||
  !pad.getStick("left").inDeadZone ||
  !pad.getStick("right").inDeadZone;

export const isFormField = (target: EventTarget | null) =>
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

  constructor(canvas: HTMLElement, superButton: HTMLElement, evadeButton: HTMLElement) {
    this.bindKeyboard();
    this.bindMouse(canvas);
    this.bindTouch(canvas, superButton);
    this.bindEvadeButton(evadeButton);
  }

  private clear() {
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
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.clear();
    this.pad.update();
    this.pad.update();
  }

  private recentTouch() {
    return performance.now() - this.lastTouch < TOUCH_GRACE_MS;
  }

  private setPointer(e: MouseEvent) {
    this.aimMethod = "pointer";
    this.ndcX = (e.clientX / window.innerWidth) * 2 - 1;
    this.ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
  }

  private bindKeyboard() {
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

  private bindEvadeButton(button: HTMLElement) {
    button.addEventListener("pointerdown", (e) => {
      if (!this.enabled || e.pointerType !== "touch") {
        return;
      }

      this.lastTouch = performance.now();
      this.setTouchMode(true);
      this.evadePressed = true;
      e.preventDefault();
    });
    button.addEventListener("click", () => {
      if (this.enabled && !this.recentTouch()) {
        this.evadePressed = true;
      }
    });
  }

  private bindMouse(canvas: HTMLElement) {
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

  private bindTouch(canvas: HTMLElement, superButton: HTMLElement) {
    canvas.addEventListener("pointerdown", (e) => this.beginTouch(e, "field"));
    superButton.addEventListener("pointerdown", (e) => this.beginTouch(e, "super"));
    superButton.addEventListener("click", () => {
      if (this.enabled && !this.recentTouch()) {
        this.shots.push({ cancelled: false, kind: "super", mag: 0, tap: true, x: 0, y: 0 });
      }
    });
    window.addEventListener("pointermove", (e) => this.moveTouch(e));
    const release = (e: PointerEvent) => this.endTouch(e);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  }

  private stickForTouch(e: PointerEvent, zone: "field" | "super") {
    if (zone === "super") {
      return this.sticks.super;
    }

    return e.clientX < window.innerWidth * MOVE_ZONE_FRACTION ? this.sticks.move : this.sticks.aim;
  }

  private stickHeldBy(e: PointerEvent) {
    return Object.values(this.sticks).find((stick) => stick.id === e.pointerId) satisfies
      | Stick
      | undefined;
  }

  private beginTouch(e: PointerEvent, zone: "field" | "super") {
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

  private moveTouch(e: PointerEvent) {
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

  private endTouch(e: PointerEvent) {
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

  setTouchMode(on: boolean) {
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
   * sim is frozen.
   */
  poll() {
    const { pad } = this;
    pad.update();

    if (!pad.connected || !this.enabled) {
      return;
    }

    if (pad.justPressed("pause")) {
      return;
    }

    if (padTouched(pad)) {
      this.aimMethod = "pad";
      this.setTouchMode(false);
    }

    if (pad.justPressed("fire")) {
      this.fire = true;
    }

    if (pad.justReleased("fire")) {
      this.fire = false;
    }

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
  padAim() {
    return this.enabled ? stickDirection(this.pad.getStick("right")) : null;
  }

  /** Press edge of a pad button or d-pad direction by its raw name (`"a"`, `"start"`, `"left"`…). */
  padJustPressed(button: string) {
    return this.enabled && this.pad.connected && this.pad.justPressed(button);
  }

  /** Left-stick deflection past the dead zone, for menu navigation edges. */
  padStick() {
    return this.enabled ? stickDirection(this.pad.getStick("left")) : null;
  }

  private keyAxis() {
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
  axis() {
    if (!this.enabled) {
      return { x: 0, z: 0 };
    }

    const { move } = this.sticks;

    if (move.id !== null && move.mag > STICK_DEAD_ZONE) {
      const len = Math.hypot(move.x, move.y) || 1;

      return { x: move.x / len, z: move.y / len };
    }

    return this.keyAxis() ?? stickDirection(this.pad.getStick("left")) ?? { x: 0, z: 0 };
  }

  /** True once per release of the super key / right mouse button. */
  consumeSuperRelease() {
    const released = this.superReleased;
    this.superReleased = false;

    return released;
  }

  /** A press starts one evade; holding a key never repeats it. */
  consumeEvade() {
    const pressed = this.evadePressed;
    this.evadePressed = false;

    return pressed;
  }

  /** Drains the touch shots queued since the last call. */
  takeShots() {
    if (this.shots.length === 0) {
      return this.shots;
    }

    const { shots } = this;
    this.shots = [];

    return shots;
  }
}
