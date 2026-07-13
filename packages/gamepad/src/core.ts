import type {
  ButtonLayout,
  ButtonOptions,
  Dir4,
  Dir8,
  Inset,
  StickGeometry,
  StickOptions,
  StickState,
  VirtualGamepadOptions,
  Viewport,
} from "./types.js";

const ZERO_INSET: Inset = { top: 0, right: 0, bottom: 0, left: 0 };

const DEFAULT_STICK: Required<StickOptions> = { radius: 64, deadZone: 8, knobRadius: 26 };
const DEFAULT_BUTTON_RADIUS = 44;

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

type ResolvedButton = {
  id: string;
  position?: (viewport: Viewport) => { x: number; y: number };
  radius: number;
  label?: string;
  rest: boolean;
};

type Binding = { kind: "stick" } | { kind: "button"; id: string };

/**
 * Framework-agnostic on-screen controls. You feed it raw pointer events
 * (`pointerDown/Move/Up`) in screen-space pixels; it tracks a floating analog
 * stick plus any number of action buttons and exposes their state for the game
 * loop to read. No DOM, no engine — pair it with `attachVirtualGamepad` from
 * `@vibedgames/gamepad/phaser`, or drive it yourself.
 *
 * Touch routing on each `pointerDown`, in order:
 *   1. fixed buttons (a touch inside a button's circle presses it),
 *   2. the stick (the first free touch anchors the floating stick),
 *   3. a "rest" button, if any (catches every other touch — the
 *      "any finger fires" model).
 */
export class VirtualGamepad {
  private readonly stickOpts: Required<StickOptions> | null;
  private readonly buttons: ResolvedButton[];
  private readonly onButtonDown?: (id: string) => void;
  private readonly onButtonUp?: (id: string) => void;

  private viewport: Viewport = { width: 0, height: 0, inset: ZERO_INSET };
  private stick: {
    pointerId: number;
    anchorX: number;
    anchorY: number;
    curX: number;
    curY: number;
  } | null = null;
  /** button id -> set of pointer ids currently pressing it. */
  private readonly pressed = new Map<string, Set<number>>();
  /** pointer id -> what it's bound to. */
  private readonly binding = new Map<number, Binding>();
  // Edge state is double-buffered: events accumulate into *Accum, and
  // nextFrame() publishes them for justPressed/justReleased to read — so an
  // edge is visible for exactly one frame no matter when the event landed.
  private downAccum = new Set<string>();
  private upAccum = new Set<string>();
  private frameDown = new Set<string>();
  private frameUp = new Set<string>();

  constructor(options: VirtualGamepadOptions = {}) {
    this.stickOpts = options.stick === false ? null : { ...DEFAULT_STICK, ...options.stick };
    this.buttons = (options.buttons ?? []).map((b: ButtonOptions) => ({
      id: b.id,
      position: b.position,
      radius: b.radius ?? DEFAULT_BUTTON_RADIUS,
      label: b.label,
      rest: !b.position,
    }));
    for (const b of this.buttons) this.pressed.set(b.id, new Set());
    this.onButtonDown = options.onButtonDown;
    this.onButtonUp = options.onButtonUp;
  }

  /** Update the canvas size so fixed buttons re-anchor (call on resize).
   *  Pass safe-area insets (see `safeAreaInset()`) so position resolvers can
   *  keep buttons clear of the notch / home indicator. */
  setViewport(width: number, height: number, inset: Inset = ZERO_INSET): void {
    this.viewport = { width, height, inset };
  }

  pointerDown(id: number, x: number, y: number): void {
    if (this.binding.has(id)) return;
    // 1. Fixed buttons claim a touch that lands inside their circle.
    for (const b of this.buttons) {
      if (b.rest || !b.position) continue;
      const c = b.position(this.viewport);
      if (Math.hypot(x - c.x, y - c.y) <= b.radius) {
        this.bindButton(b.id, id);
        return;
      }
    }
    // 2. The first free touch anchors the floating stick.
    if (this.stickOpts && !this.stick) {
      this.stick = { pointerId: id, anchorX: x, anchorY: y, curX: x, curY: y };
      this.binding.set(id, { kind: "stick" });
      return;
    }
    // 3. A "rest" button (if defined) catches everything else.
    const rest = this.buttons.find((b) => b.rest);
    if (rest) this.bindButton(rest.id, id);
  }

  pointerMove(id: number, x: number, y: number): void {
    if (this.stick && this.stick.pointerId === id) {
      this.stick.curX = x;
      this.stick.curY = y;
    }
  }

  pointerUp(id: number): void {
    const b = this.binding.get(id);
    if (!b) return;
    this.binding.delete(id);
    if (b.kind === "stick") {
      this.stick = null;
      return;
    }
    const set = this.pressed.get(b.id);
    if (set) {
      set.delete(id);
      if (set.size === 0) {
        this.upAccum.add(b.id);
        this.onButtonUp?.(b.id);
      }
    }
  }

  /**
   * Drop any tracked pointer that's no longer physically down. Touch `up`
   * events go missing when a finger slides off the canvas, so call this each
   * frame with the engine's live pointer ids.
   */
  reconcile(activeIds: Iterable<number>): void {
    const live = activeIds instanceof Set ? activeIds : new Set(activeIds);
    // Snapshot keys: pointerUp mutates `binding` mid-loop.
    for (const id of Array.from(this.binding.keys())) {
      if (!live.has(id)) this.pointerUp(id);
    }
  }

  /** Release everything (e.g. on respawn or scene reset). */
  reset(): void {
    for (const id of Array.from(this.binding.keys())) this.pointerUp(id);
  }

  /** True while any finger is touching the gamepad. */
  get isTouching(): boolean {
    return this.binding.size > 0;
  }

  isButtonDown(id: string): boolean {
    return (this.pressed.get(id)?.size ?? 0) > 0;
  }

  /** Button went up→down since the previous `nextFrame()` — edge-triggered
   *  polling for fixed-timestep games (tap = one action). The callback
   *  alternative is `onButtonDown`. */
  justPressed(id: string): boolean {
    return this.frameDown.has(id);
  }

  /** Last finger left the button since the previous `nextFrame()`. */
  justReleased(id: string): boolean {
    return this.frameUp.has(id);
  }

  /**
   * Publish accumulated edges for `justPressed`/`justReleased` and start a new
   * accumulation window. The adapters call this from their `update()`; call it
   * once per frame yourself only when driving the core directly.
   */
  nextFrame(): void {
    [this.frameDown, this.downAccum] = [this.downAccum, this.frameDown];
    this.downAccum.clear();
    [this.frameUp, this.upAccum] = [this.upAccum, this.frameUp];
    this.upAccum.clear();
  }

  /** Ids of all buttons with at least one finger down. */
  buttonsDown(): string[] {
    const out: string[] = [];
    for (const [id, set] of this.pressed) if (set.size > 0) out.push(id);
    return out;
  }

  /** A snapshot of the stick. Idle when no finger owns it. */
  getStick(): StickState {
    const o = this.stickOpts;
    const s = this.stick;
    if (!o || !s) return { ...IDLE_STICK }; // fresh copy — never hand out the shared singleton
    const dx = s.curX - s.anchorX;
    const dy = s.curY - s.anchorY;
    const distance = Math.hypot(dx, dy);
    // Guard against a misconfigured deadZone >= radius (span <= 0 → NaN/∞).
    const span = Math.max(1, o.radius - o.deadZone);
    const magnitude = Math.min(1, Math.max(0, (distance - o.deadZone) / span));
    return {
      active: true,
      anchorX: s.anchorX,
      anchorY: s.anchorY,
      curX: s.curX,
      curY: s.curY,
      dx,
      dy,
      distance,
      angle: Math.atan2(dy, dx),
      magnitude,
      inDeadZone: distance <= o.deadZone,
    };
  }

  /** Resolved stick tuning, or null if the stick is disabled. */
  getStickGeometry(): StickGeometry | null {
    return this.stickOpts ? { ...this.stickOpts } : null;
  }

  /** Resolved button geometry + state, for renderers. */
  getButtonLayout(): ButtonLayout[] {
    return this.buttons.map((b) => {
      const c = b.rest || !b.position ? { x: 0, y: 0 } : b.position(this.viewport);
      return {
        id: b.id,
        x: c.x,
        y: c.y,
        radius: b.radius,
        label: b.label,
        pressed: this.isButtonDown(b.id),
        rest: b.rest,
      };
    });
  }

  private bindButton(buttonId: string, pointerId: number): void {
    const set = this.pressed.get(buttonId);
    if (!set) return;
    const wasDown = set.size > 0;
    set.add(pointerId);
    this.binding.set(pointerId, { kind: "button", id: buttonId });
    if (!wasDown) {
      this.downAccum.add(buttonId);
      this.onButtonDown?.(buttonId);
    }
  }
}

/** Snap a stick reading to a 4-way direction, or null in the dead zone. */
export function stickDirection4(stick: StickState): Dir4 | null {
  if (!stick.active || stick.inDeadZone) return null;
  const deg = ((((stick.angle * 180) / Math.PI) % 360) + 360) % 360;
  if (deg >= 45 && deg < 135) return "down";
  if (deg >= 135 && deg < 225) return "left";
  if (deg >= 225 && deg < 315) return "up";
  return "right";
}

/** Snap a stick reading to an 8-way direction, or null in the dead zone. */
export function stickDirection8(stick: StickState): Dir8 | null {
  if (!stick.active || stick.inDeadZone) return null;
  const deg = ((((stick.angle * 180) / Math.PI) % 360) + 360) % 360;
  const sectors: readonly Dir8[] = [
    "right",
    "down-right",
    "down",
    "down-left",
    "left",
    "up-left",
    "up",
    "up-right",
  ];
  return sectors[Math.round(deg / 45) % 8] ?? "right";
}
