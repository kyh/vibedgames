import { VirtualGamepad } from "./core";
import { preShow, safeAreaInset } from "./safe-area";
import type { StickState, VirtualGamepadOptions, VisibilityPolicy } from "./types";

export type DomGamepadRenderOptions = {
  /** z-index of the overlay container (default 40 — above the canvas, below
   *  modal HUD). */
  zIndex?: number;
  /** Knob + button accent as a CSS color (default "#fff"). Change at runtime
   *  with `setTint`. */
  tint?: string;
};

export type DomGamepadOptions = VirtualGamepadOptions & {
  /** Element the overlay is appended to (default `document.body`). */
  root?: HTMLElement;
  /** When the overlay renders: "touch" after the first touch (default),
   *  "coarse" pre-shown on touch-capable devices so fixed buttons are
   *  discoverable, or "always". */
  visible?: VisibilityPolicy;
  /** Built-in DOM renderer config, or `false` to render it yourself from the
   *  exposed `pad`. */
  render?: false | DomGamepadRenderOptions;
  /** Fired the first time a touch is seen — e.g. swap a control hint. */
  onFirstTouch?: () => void;
  /**
   * Touches whose event target matches are left to the page (they never reach
   * the pad). Defaults to interactive elements — `button`, `a`, `input`,
   * `select`, `textarea`, `[data-gamepad-ignore]` — so a rest button doesn't
   * swallow taps on HUD controls.
   */
  ignore?: (target: EventTarget | null) => boolean;
};

export type DomGamepad = {
  /** The underlying framework-agnostic controller. */
  readonly pad: VirtualGamepad;
  /** True once any touch has been seen this session (stays true). */
  readonly isTouch: boolean;
  getStick(): StickState;
  isButtonDown(id: string): boolean;
  /** Edge-triggered press since last `update()` (tap = one action). */
  justPressed(id: string): boolean;
  justReleased(id: string): boolean;
  /** Recolor the knob + buttons (CSS color). */
  setTint(color: string): void;
  /** Call once per frame from your game loop: publishes press edges and
   *  redraws the overlay. */
  update(): void;
  destroy(): void;
};

const defaultIgnore = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest("button, a, input, select, textarea, [data-gamepad-ignore]") !== null;

const placement = (x: number, y: number, r: number): Record<string, string> => ({
  transform: `translate(${x - r}px, ${y - r}px)`,
  width: `${r * 2}px`,
  height: `${r * 2}px`,
});

/**
 * Wire a {@link VirtualGamepad} to a plain DOM page — the adapter for
 * non-Phaser games (Three.js, canvas, anything). Listens for touch pointer
 * events on `window` (mouse is ignored so desktop keeps its own controls) and
 * renders the floating stick + fixed buttons as positioned DOM elements in a
 * `pointer-events:none` overlay, so it never steals taps from the page.
 *
 * The page is responsible for `touch-action: none` on its game surface —
 * without it the browser may scroll/zoom instead of delivering moves.
 *
 * ```ts
 * const gamepad = attachDomGamepad({
 *   visible: "coarse",
 *   buttons: [{ id: "jump", label: "JUMP", position: (v) => ({
 *     x: v.width - 72 - v.inset.right, y: v.height - 72 - v.inset.bottom,
 *   }) }],
 * });
 * // in your game loop:
 * gamepad.update();
 * const stick = gamepad.getStick();
 * if (gamepad.justPressed("jump")) jump();
 * ```
 */
export function attachDomGamepad(options: DomGamepadOptions = {}): DomGamepad {
  const pad = new VirtualGamepad(options);
  const ignore = options.ignore ?? defaultIgnore;
  const policy = options.visible ?? "touch";
  const renderOpts = options.render === false ? null : (options.render ?? {});
  let isTouch = false;
  let tint = renderOpts?.tint ?? "#fff";
  let destroyed = false;

  const live = new Set<number>();

  const syncViewport = (): void =>
    pad.setViewport(window.innerWidth, window.innerHeight, safeAreaInset());
  syncViewport();

  const onDown = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") return; // mouse stays on the game's own controls
    if (!isTouch) {
      isTouch = true;
      options.onFirstTouch?.();
    }
    if (ignore(e.target)) return;
    live.add(e.pointerId);
    pad.pointerDown(e.pointerId, e.clientX, e.clientY);
  };
  const onMove = (e: PointerEvent): void => {
    if (e.pointerType === "touch") pad.pointerMove(e.pointerId, e.clientX, e.clientY);
  };
  const onUp = (e: PointerEvent): void => {
    live.delete(e.pointerId);
    pad.pointerUp(e.pointerId);
  };
  const onGone = (): void => {
    live.clear();
    pad.reset();
  };

  window.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  window.addEventListener("blur", onGone);
  window.addEventListener("resize", syncViewport);

  const view = renderOpts ? createOverlay(options.root ?? document.body, renderOpts) : null;

  return {
    pad,
    get isTouch() {
      return isTouch;
    },
    getStick: () => pad.getStick(),
    isButtonDown: (id) => pad.isButtonDown(id),
    justPressed: (id) => pad.justPressed(id),
    justReleased: (id) => pad.justReleased(id),
    setTint(color) {
      tint = color;
    },
    update() {
      pad.reconcile(live);
      pad.nextFrame();
      view?.draw(pad, tint, isTouch || preShow(policy));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onGone);
      window.removeEventListener("resize", syncViewport);
      view?.root.remove();
    },
  };
}

type Overlay = {
  root: HTMLElement;
  draw(pad: VirtualGamepad, tint: string, show: boolean): void;
};

// All chrome is drawn with white at fixed alphas; only the accent (knob fill,
// button border) takes the tint — mirrors the Phaser renderer's look.
function createOverlay(parent: HTMLElement, opts: DomGamepadRenderOptions): Overlay {
  const root = document.createElement("div");
  root.className = "vg-gamepad";
  root.style.cssText =
    `position:fixed;inset:0;pointer-events:none;z-index:${opts.zIndex ?? 40};` +
    "font-family:system-ui,sans-serif;user-select:none;-webkit-user-select:none;";
  parent.appendChild(root);

  // Nodes are positioned with transform (top-left stays 0,0) and every style
  // write is diffed through this cache, so an idle overlay costs zero style
  // recalcs and a moving knob is compositor-only.
  const applied = new Map<HTMLElement, Record<string, string>>();
  const set = (node: HTMLElement, styles: Record<string, string>): void => {
    let prev = applied.get(node);
    if (!prev) {
      prev = {};
      applied.set(node, prev);
    }
    for (const [key, value] of Object.entries(styles)) {
      if (prev[key] === value) continue;
      prev[key] = value;
      if (key === "text") node.textContent = value;
      else node.style.setProperty(key, value);
    }
  };
  const el = (cls: string, css: string): HTMLElement => {
    const d = document.createElement("div");
    d.className = cls;
    d.style.cssText = css;
    root.appendChild(d);
    return d;
  };
  const circle =
    "position:absolute;left:0;top:0;border-radius:50%;box-sizing:border-box;display:none;will-change:transform;";
  const base = el(
    "vg-stick-base",
    `${circle}background:rgba(255,255,255,.05);border:2px solid rgba(255,255,255,.2);`,
  );
  const knob = el("vg-stick-knob", `${circle}border:2px solid;`);
  const buttons = new Map<string, HTMLElement>();

  return {
    root,
    draw(pad, tint, show) {
      const stick = pad.getStick();
      const geom = pad.getStickGeometry();
      const stickOn = show && stick.active && geom !== null;
      set(base, { display: stickOn ? "block" : "none" });
      set(knob, { display: stickOn ? "block" : "none" });
      if (stickOn && geom) {
        // Puck clamps to the ring edge so it never escapes the base.
        const clamped = Math.min(stick.distance, geom.radius);
        const kx =
          stick.distance > 0.001
            ? stick.anchorX + (stick.dx / stick.distance) * clamped
            : stick.anchorX;
        const ky =
          stick.distance > 0.001
            ? stick.anchorY + (stick.dy / stick.distance) * clamped
            : stick.anchorY;
        set(base, placement(stick.anchorX, stick.anchorY, geom.radius));
        set(knob, {
          ...placement(kx, ky, geom.knobRadius),
          "border-color": tint,
          background: `color-mix(in srgb, ${tint} 25%, transparent)`,
        });
      }
      for (const b of pad.getButtonLayout()) {
        if (b.rest) continue; // rest buttons have no on-screen position
        let node = buttons.get(b.id);
        if (!node) {
          node = el(
            "vg-btn",
            `${circle}border:2px solid;align-items:center;justify-content:center;` +
              "font-weight:600;letter-spacing:.04em;color:rgba(255,255,255,.92);",
          );
          node.dataset["id"] = b.id;
          buttons.set(b.id, node);
        }
        if (!show) {
          set(node, { display: "none" });
          continue;
        }
        set(node, {
          ...placement(b.x, b.y, b.radius),
          display: "flex",
          text: b.label ?? "",
          "font-size": `${Math.round(b.radius * 0.42)}px`,
          "border-color": tint,
          opacity: b.pressed ? "1" : "0.55",
          background: b.pressed
            ? `color-mix(in srgb, ${tint} 34%, transparent)`
            : "rgba(255,255,255,.08)",
        });
      }
    },
  };
}

export { VirtualGamepad, stickDirection4, stickDirection8 } from "./core";
export { PhysicalGamepad, isPadConnected } from "./physical";
export { safeAreaInset } from "./safe-area";
export type { PadButton, PhysicalGamepadOptions } from "./physical";
export type {
  ButtonLayout,
  ButtonOptions,
  Dir4,
  Dir8,
  Inset,
  StickGeometry,
  StickOptions,
  StickState,
  Vec2,
  VirtualGamepadOptions,
  Viewport,
  VisibilityPolicy,
} from "./types";
