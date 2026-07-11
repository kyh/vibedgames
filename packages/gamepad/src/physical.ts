import type { StickState } from "./types";

/** Standard-mapping button names (https://w3c.github.io/gamepad/#remapping).
 *  Non-standard pads are read with the same indices — best effort. */
export type PadButton =
  | "a"
  | "b"
  | "x"
  | "y"
  | "lb"
  | "rb"
  | "lt"
  | "rt"
  | "select"
  | "start"
  | "ls"
  | "rs"
  | "up"
  | "down"
  | "left"
  | "right";

const BUTTON_INDEX: Readonly<Record<PadButton, number>> = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  select: 8,
  start: 9,
  ls: 10,
  rs: 11,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
};

const PAD_BUTTONS: readonly PadButton[] = [
  "a",
  "b",
  "x",
  "y",
  "lb",
  "rb",
  "lt",
  "rt",
  "select",
  "start",
  "ls",
  "rs",
  "up",
  "down",
  "left",
  "right",
];

const PAD_BUTTON_NAMES: ReadonlySet<string> = new Set(PAD_BUTTONS);

function isPadButton(id: string): id is PadButton {
  return PAD_BUTTON_NAMES.has(id);
}

export type PhysicalGamepadOptions = {
  /**
   * Game action id → physical buttons, so a game reads the SAME ids from this
   * pad as from its {@link VirtualGamepad} buttons (e.g. `"jump"`, `"fire"`).
   * Raw {@link PadButton} names always work without a binding.
   */
  bindings?: Readonly<Record<string, readonly PadButton[]>>;
  /** Stick deflection (0–1) treated as noise. Default 0.15. */
  stickDeadZone?: number;
  /** Analog trigger value above which lt/rt count as pressed. Default 0.05. */
  triggerThreshold?: number;
  /** Fired when the first pad appears (polled — fires on the next update()). */
  onConnect?: () => void;
  /** Fired when the last pad disappears. */
  onDisconnect?: () => void;
  /** Pad source, injectable for tests. Default `navigator.getGamepads()`. */
  poll?: () => ReadonlyArray<Gamepad | null>;
};

const DEFAULT_STICK_DEAD_ZONE = 0.15;
const DEFAULT_TRIGGER_THRESHOLD = 0.05;

const IDLE_STICK: StickState = {
  active: false,
  anchorX: 0,
  anchorY: 0,
  curX: 0,
  curY: 0,
  dx: 0,
  dy: 0,
  distance: 0,
  angle: 0,
  magnitude: 0,
  inDeadZone: true,
};

function defaultPoll(): ReadonlyArray<Gamepad | null> {
  return typeof navigator !== "undefined" && typeof navigator.getGamepads === "function"
    ? navigator.getGamepads()
    : [];
}

/** True if any physical pad is currently connected — e.g. to decide whether
 *  controller rows belong on an instructions screen. */
export function isPadConnected(): boolean {
  return defaultPoll().some((pad) => pad?.connected ?? false);
}

/**
 * Physical controller input, API-mirroring {@link VirtualGamepad} so a game's
 * read path works for both: `isButtonDown(id)` / `justPressed(id)` /
 * `getStick()`. Poll-based — call `update()` once per frame; edges are
 * published per update, matching the virtual pad's `nextFrame()` semantics.
 * The first connected pad wins. No DOM, no engine, no listeners.
 *
 * ```ts
 * const pad = new PhysicalGamepad({ bindings: { jump: ["a"], dash: ["b", "rb"] } });
 * // in your game loop:
 * pad.update();
 * const dir = stickDirection4(pad.getStick());
 * if (pad.justPressed("jump")) jump();
 * ```
 */
export class PhysicalGamepad {
  private readonly bindings: Readonly<Record<string, readonly PadButton[]>>;
  private readonly stickDeadZone: number;
  private readonly triggerThreshold: number;
  private readonly onConnect?: () => void;
  private readonly onDisconnect?: () => void;
  private readonly poll: () => ReadonlyArray<Gamepad | null>;

  private wasConnected = false;
  private axes: readonly number[] = [];
  private down = new Set<PadButton>();
  private prevDown = new Set<PadButton>();
  /** Raw analog values (triggers), by button name. */
  private values = new Map<PadButton, number>();

  constructor(options: PhysicalGamepadOptions = {}) {
    this.bindings = options.bindings ?? {};
    this.stickDeadZone = options.stickDeadZone ?? DEFAULT_STICK_DEAD_ZONE;
    this.triggerThreshold = options.triggerThreshold ?? DEFAULT_TRIGGER_THRESHOLD;
    this.onConnect = options.onConnect;
    this.onDisconnect = options.onDisconnect;
    this.poll = options.poll ?? defaultPoll;
  }

  /** Poll the first connected pad and publish press edges for this frame. */
  update(): void {
    let pad: Gamepad | null = null;
    for (const candidate of this.poll()) {
      if (candidate?.connected) {
        pad = candidate;
        break;
      }
    }

    const connected = pad !== null;
    if (connected !== this.wasConnected) {
      this.wasConnected = connected;
      if (connected) this.onConnect?.();
      else this.onDisconnect?.();
    }

    // Swap, then rebuild — prevDown keeps last frame's state for edge reads.
    [this.prevDown, this.down] = [this.down, this.prevDown];
    this.down.clear();
    this.values.clear();
    this.axes = pad ? [...pad.axes] : [];
    if (!pad) return;

    for (const name of PAD_BUTTONS) {
      const button = pad.buttons[BUTTON_INDEX[name]];
      if (!button) continue;
      this.values.set(name, button.value);
      // Triggers report analog values; some pads never set `pressed` for a
      // light pull, so a value past the threshold also counts as down.
      if (button.pressed || button.value > this.triggerThreshold) this.down.add(name);
    }
  }

  /** A pad was connected as of the last `update()`. */
  get connected(): boolean {
    return this.wasConnected;
  }

  /** `id` is a binding action id or a raw {@link PadButton} name. */
  isButtonDown(id: string): boolean {
    return this.resolve(id).some((b) => this.down.has(b));
  }

  /** Action went up→down since the previous `update()` (any bound button). */
  justPressed(id: string): boolean {
    const buttons = this.resolve(id);
    return buttons.some((b) => this.down.has(b)) && !buttons.some((b) => this.prevDown.has(b));
  }

  /** Action went down→up since the previous `update()` (all bound buttons up). */
  justReleased(id: string): boolean {
    const buttons = this.resolve(id);
    return buttons.some((b) => this.prevDown.has(b)) && !buttons.some((b) => this.down.has(b));
  }

  /** Raw analog value 0–1 (triggers are the interesting case). 0 when absent. */
  buttonValue(button: PadButton): number {
    return this.values.get(button) ?? 0;
  }

  /**
   * A stick reading in {@link StickState} form (axes 0/1 left, 2/3 right;
   * y-down matches screen space), so `stickDirection4/8` work unchanged.
   * `active` while a pad is connected; dead-zoned like the virtual stick.
   */
  getStick(side: "left" | "right" = "left"): StickState {
    if (!this.wasConnected) return { ...IDLE_STICK };
    const base = side === "left" ? 0 : 2;
    const dx = this.axes[base] ?? 0;
    const dy = this.axes[base + 1] ?? 0;
    const distance = Math.hypot(dx, dy);
    const span = Math.max(1e-6, 1 - this.stickDeadZone);
    return {
      active: true,
      anchorX: 0,
      anchorY: 0,
      curX: dx,
      curY: dy,
      dx,
      dy,
      distance,
      angle: Math.atan2(dy, dx),
      magnitude: Math.min(1, Math.max(0, (distance - this.stickDeadZone) / span)),
      inDeadZone: distance <= this.stickDeadZone,
    };
  }

  /** Release all state (the class holds no listeners — this just clears). */
  destroy(): void {
    this.down.clear();
    this.prevDown.clear();
    this.values.clear();
    this.axes = [];
    this.wasConnected = false;
  }

  private resolve(id: string): readonly PadButton[] {
    const bound = this.bindings[id];
    if (bound) return bound;
    return isPadButton(id) ? [id] : [];
  }
}
