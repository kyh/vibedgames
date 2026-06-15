/** A 2D point / vector in screen-space pixels. */
export type Vec2 = { x: number; y: number };

/** Current canvas size, used to re-anchor fixed buttons on resize. */
export type Viewport = { width: number; height: number };

/** Tuning for the floating analog stick. All distances are screen-space px. */
export type StickOptions = {
  /** Drag distance from the anchor that maps to full magnitude (1.0). */
  radius?: number;
  /** No magnitude / no aim within this drag of the anchor — a parked thumb
   *  doesn't jitter the heading. */
  deadZone?: number;
  /** Visual knob (inner puck) radius, used by renderers. */
  knobRadius?: number;
};

/** A button on the virtual gamepad. */
export type ButtonOptions = {
  /** Stable id you read back with `isButtonDown(id)`. */
  id: string;
  /** Fixed on-screen button: resolves a center given the current viewport, so
   *  the button re-anchors on resize. Omit `position` to make this a "rest"
   *  button that captures ANY touch not on the stick or another fixed button
   *  (the "any other finger fires" model). */
  position?: (viewport: Viewport) => Vec2;
  /** Hit-test + render radius for a fixed button. Ignored by rest buttons. */
  radius?: number;
  /** Optional glyph/label a custom renderer may draw. */
  label?: string;
};

export type VirtualGamepadOptions = {
  /** Floating analog stick config, or `false` to disable the stick entirely. */
  stick?: StickOptions | false;
  /** Action buttons (fixed or "rest"). Evaluated in order on each touch — put
   *  the most specific fixed buttons first; a "rest" button (if any) is the
   *  fallback for touches that hit nothing else. */
  buttons?: ButtonOptions[];
  /** Edge callback the first frame a button goes from up→down (e.g. place a
   *  bomb on tap). For held input, read `isButtonDown` each frame instead. */
  onButtonDown?: (id: string) => void;
  /** Edge callback when the last finger leaves a button (down→up). */
  onButtonUp?: (id: string) => void;
};

/** A read-only snapshot of the stick. Fields collapse to 0 when idle. */
export type StickState = {
  /** A finger is on the stick. */
  active: boolean;
  /** Where the finger first landed. */
  anchorX: number;
  anchorY: number;
  /** Current finger position. */
  curX: number;
  curY: number;
  /** Current minus anchor. */
  dx: number;
  dy: number;
  /** Raw drag distance from the anchor (un-clamped). */
  distance: number;
  /** Drag heading in radians (`atan2(dy, dx)`, screen-space y-down); 0 idle. */
  angle: number;
  /** 0–1 thrust after the dead zone, clamped at `radius`. */
  magnitude: number;
  /** Drag is within the dead zone — don't re-aim or thrust this frame. */
  inDeadZone: boolean;
};

/** Resolved stick tuning (defaults applied), for renderers. */
export type StickGeometry = {
  radius: number;
  deadZone: number;
  knobRadius: number;
};

/** Resolved button geometry + state, for renderers. */
export type ButtonLayout = {
  id: string;
  /** Center (0,0 for rest buttons, which have no fixed position). */
  x: number;
  y: number;
  radius: number;
  label?: string;
  pressed: boolean;
  /** Rest buttons have no fixed position — renderers skip them. */
  rest: boolean;
};

/** Four-way snapped direction (screen-space: +y is down). */
export type Dir4 = "up" | "down" | "left" | "right";
/** Eight-way snapped direction. */
export type Dir8 = Dir4 | "up-left" | "up-right" | "down-left" | "down-right";
