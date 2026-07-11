import Phaser from "phaser";

import { VirtualGamepad } from "./core";
import { preShow, safeAreaInset } from "./safe-area";
import type { StickState, VirtualGamepadOptions, VisibilityPolicy } from "./types";

export type PhaserGamepadRenderOptions = {
  /** Render depth of the overlay Graphics (default 95 — above the world,
   *  below a DOM HUD). */
  depth?: number;
  /** Knob + button color (default white). Change at runtime with `setTint`. */
  tint?: number;
  /** Blend mode for the Graphics (default `Phaser.BlendModes.ADD` so it glows
   *  over a dark scene). Button labels always render NORMAL for legibility. */
  blendMode?: Phaser.BlendModes;
};

export type PhaserGamepadOptions = VirtualGamepadOptions & {
  /** Extra simultaneous pointers to register. Defaults to one per button plus
   *  two for the stick + a spare, so simultaneous holds are never dropped. */
  extraPointers?: number;
  /** When the overlay renders: "touch" after the first touch (default),
   *  "coarse" pre-shown on touch-capable devices so fixed buttons are
   *  discoverable, or "always". */
  visible?: VisibilityPolicy;
  /** Built-in Graphics renderer config, or `false` to render it yourself from
   *  the exposed `pad`. */
  render?: false | PhaserGamepadRenderOptions;
  /** Fired the first time a touch is seen — e.g. swap an on-screen control
   *  hint, or hide a desktop cursor prompt. */
  onFirstTouch?: () => void;
};

export type PhaserGamepad = {
  /** The underlying framework-agnostic controller. */
  readonly pad: VirtualGamepad;
  /** True once any touch has been seen this session (stays true). */
  readonly isTouch: boolean;
  /** Current stick reading. */
  getStick(): StickState;
  isButtonDown(id: string): boolean;
  /** Edge-triggered press since last `update()` (tap = one action). */
  justPressed(id: string): boolean;
  justReleased(id: string): boolean;
  /** Recolor the knob + buttons (e.g. to the local player's color). */
  setTint(color: number): void;
  /** Call once per frame from your scene's `update()`: reconciles stale
   *  pointers, publishes press edges, and redraws the overlay. */
  update(): void;
  destroy(): void;
};

/**
 * Wire a {@link VirtualGamepad} to a Phaser scene: registers extra pointers,
 * forwards touch events (mouse is ignored so a desktop game keeps its own
 * cursor controls), and draws a screen-fixed joystick + buttons overlay.
 *
 * ```ts
 * const gamepad = attachVirtualGamepad(this, {
 *   buttons: [{ id: "fire" }], // a "rest" button: any 2nd finger fires
 *   onFirstTouch: () => hideHint(),
 * });
 * // in update():
 * gamepad.update();
 * const stick = gamepad.getStick();
 * if (stick.active && !stick.inDeadZone) steer(stick.angle, stick.magnitude);
 * if (gamepad.isButtonDown("fire")) shoot();
 * ```
 */
export function attachVirtualGamepad(
  scene: Phaser.Scene,
  options: PhaserGamepadOptions = {},
): PhaserGamepad {
  const pad = new VirtualGamepad(options);
  let isTouch = false;
  const policy = options.visible ?? "touch";
  const renderOpts = options.render === false ? null : (options.render ?? {});
  let tint = renderOpts?.tint ?? 0xffffff;

  scene.input.addPointer(options.extraPointers ?? Math.max(2, (options.buttons?.length ?? 0) + 2));

  const syncViewport = (): void => {
    const { width, height } = scene.scale;
    // Phaser's logical size can differ from CSS pixels (FIT/zoom modes) —
    // scale the CSS-px insets into scene units so anchored buttons don't
    // overshoot on notched phones.
    const raw = safeAreaInset();
    const sx = window.innerWidth > 0 ? width / window.innerWidth : 1;
    const sy = window.innerHeight > 0 ? height / window.innerHeight : 1;
    pad.setViewport(width, height, {
      top: raw.top * sy,
      right: raw.right * sx,
      bottom: raw.bottom * sy,
      left: raw.left * sx,
    });
  };
  syncViewport();

  const onDown = (p: Phaser.Input.Pointer): void => {
    if (!p.wasTouch) return; // mouse stays on the game's own control model
    if (!isTouch) {
      isTouch = true;
      options.onFirstTouch?.();
    }
    syncViewport();
    pad.pointerDown(p.id, p.x, p.y);
  };
  const onMove = (p: Phaser.Input.Pointer): void => {
    if (p.wasTouch) pad.pointerMove(p.id, p.x, p.y);
  };
  const onUp = (p: Phaser.Input.Pointer): void => pad.pointerUp(p.id);

  scene.input.on(Phaser.Input.Events.POINTER_DOWN, onDown);
  scene.input.on(Phaser.Input.Events.POINTER_MOVE, onMove);
  scene.input.on(Phaser.Input.Events.POINTER_UP, onUp);

  let gfx: Phaser.GameObjects.Graphics | null = null;
  const labels = new Map<string, Phaser.GameObjects.Text>();
  if (renderOpts) {
    gfx = scene.add
      .graphics()
      .setScrollFactor(0)
      .setDepth(renderOpts.depth ?? 95)
      .setBlendMode(renderOpts.blendMode ?? Phaser.BlendModes.ADD);
  }

  const draw = (): void => {
    if (!gfx) return;
    gfx.clear();
    const show = isTouch || preShow(policy);
    if (show) drawGamepad(gfx, pad, tint);
    syncLabels(scene, gfx, pad, labels, show);
  };

  return {
    pad,
    get isTouch() {
      return isTouch;
    },
    getStick: () => pad.getStick(),
    isButtonDown: (id) => pad.isButtonDown(id),
    justPressed: (id) => pad.justPressed(id),
    justReleased: (id) => pad.justReleased(id),
    setTint: (color) => {
      tint = color;
    },
    update() {
      const live: number[] = [];
      for (const ptr of scene.input.manager.pointers) if (ptr.isDown) live.push(ptr.id);
      pad.reconcile(live);
      pad.nextFrame();
      syncViewport();
      draw();
    },
    destroy() {
      scene.input.off(Phaser.Input.Events.POINTER_DOWN, onDown);
      scene.input.off(Phaser.Input.Events.POINTER_MOVE, onMove);
      scene.input.off(Phaser.Input.Events.POINTER_UP, onUp);
      gfx?.destroy();
      for (const t of labels.values()) t.destroy();
      labels.clear();
    },
  };
}

/** Keep a Text object per labeled fixed button (Graphics can't draw text). */
function syncLabels(
  scene: Phaser.Scene,
  gfx: Phaser.GameObjects.Graphics,
  pad: VirtualGamepad,
  labels: Map<string, Phaser.GameObjects.Text>,
  show: boolean,
): void {
  for (const b of pad.getButtonLayout()) {
    if (b.rest || !b.label) continue;
    let text = labels.get(b.id);
    if (!text) {
      text = scene.add
        .text(0, 0, b.label, {
          fontFamily: "system-ui, sans-serif",
          fontStyle: "600",
          color: "#ffffff",
        })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(gfx.depth + 1);
      labels.set(b.id, text);
    }
    text.setVisible(show);
    if (!show) continue;
    text.setPosition(b.x, b.y);
    text.setFontSize(Math.round(b.radius * 0.42));
    text.setAlpha(b.pressed ? 1 : 0.75);
  }
}

/** Draw the joystick + fixed buttons into a Graphics object (screen-space). */
function drawGamepad(g: Phaser.GameObjects.Graphics, pad: VirtualGamepad, tint: number): void {
  const geom = pad.getStickGeometry();
  const stick = pad.getStick();
  if (geom && stick.active) {
    const { radius, deadZone, knobRadius } = geom;
    const ax = stick.anchorX;
    const ay = stick.anchorY;
    // Puck clamps to the ring edge so it never escapes the base.
    const clamped = Math.min(stick.distance, radius);
    const kx = stick.distance > 0.001 ? ax + (stick.dx / stick.distance) * clamped : ax;
    const ky = stick.distance > 0.001 ? ay + (stick.dy / stick.distance) * clamped : ay;
    g.fillStyle(0xffffff, 0.05).fillCircle(ax, ay, radius);
    g.lineStyle(2, 0xffffff, 0.2).strokeCircle(ax, ay, radius);
    g.fillStyle(0xffffff, 0.12).fillCircle(ax, ay, deadZone);
    g.fillStyle(tint, 0.22).fillCircle(kx, ky, knobRadius);
    g.lineStyle(2, tint, 0.85).strokeCircle(kx, ky, knobRadius);
  }
  for (const b of pad.getButtonLayout()) {
    if (b.rest) continue; // rest buttons have no on-screen position
    g.fillStyle(tint, b.pressed ? 0.34 : 0.12);
    g.fillCircle(b.x, b.y, b.radius);
    g.lineStyle(2, tint, b.pressed ? 0.95 : 0.45);
    g.strokeCircle(b.x, b.y, b.radius);
  }
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
