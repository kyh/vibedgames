import Phaser from "phaser";

import { VirtualGamepad } from "./core";
import type { StickState, VirtualGamepadOptions } from "./types";

export type PhaserGamepadRenderOptions = {
  /** Render depth of the overlay Graphics (default 95 — above the world,
   *  below a DOM HUD). */
  depth?: number;
  /** Knob + button color (default white). Change at runtime with `setTint`. */
  tint?: number;
  /** Blend mode for the Graphics (default `Phaser.BlendModes.ADD` so it glows
   *  over a dark scene). */
  blendMode?: Phaser.BlendModes;
};

export type PhaserGamepadOptions = VirtualGamepadOptions & {
  /** Extra simultaneous pointers to register (default 2 → 3 total: the stick
   *  plus two action fingers). */
  extraPointers?: number;
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
  /** Recolor the knob + buttons (e.g. to the local player's color). */
  setTint(color: number): void;
  /** Call once per frame from your scene's `update()`: reconciles stale
   *  pointers and redraws the overlay. */
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
  const renderOpts = options.render === false ? null : (options.render ?? {});
  let tint = renderOpts?.tint ?? 0xffffff;

  scene.input.addPointer(options.extraPointers ?? 2);

  const syncViewport = (): void => pad.setViewport(scene.scale.width, scene.scale.height);
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
    if (!isTouch) return;
    drawGamepad(gfx, pad, tint);
  };

  return {
    pad,
    get isTouch() {
      return isTouch;
    },
    getStick: () => pad.getStick(),
    isButtonDown: (id) => pad.isButtonDown(id),
    setTint: (color) => {
      tint = color;
    },
    update() {
      const live: number[] = [];
      for (const ptr of scene.input.manager.pointers) if (ptr.isDown) live.push(ptr.id);
      pad.reconcile(live);
      syncViewport();
      draw();
    },
    destroy() {
      scene.input.off(Phaser.Input.Events.POINTER_DOWN, onDown);
      scene.input.off(Phaser.Input.Events.POINTER_MOVE, onMove);
      scene.input.off(Phaser.Input.Events.POINTER_UP, onUp);
      gfx?.destroy();
    },
  };
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
export type {
  ButtonLayout,
  ButtonOptions,
  Dir4,
  Dir8,
  StickGeometry,
  StickOptions,
  StickState,
  Vec2,
  VirtualGamepadOptions,
  Viewport,
} from "./types";
