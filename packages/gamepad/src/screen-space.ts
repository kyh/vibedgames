import type { Vec2 } from "./types.js";

/**
 * The camera state that decides where a `scrollFactor(0)` object lands on the
 * canvas. Phaser draws everything through
 * `translate(pivot) · rotate · scale(zoom) · translate(-pivot)`, and a zero
 * scroll factor cancels the camera's *scroll* and nothing else — so a
 * "screen-fixed" overlay still rides the zoom and the roll, and drifts away
 * from the coordinates it hit-tests in.
 *
 * Assumes the camera's viewport covers the canvas, which is also the only case
 * where canvas-space hit testing means anything.
 */
export type CameraView = {
  width: number;
  height: number;
  /** Normalised pivot of zoom + rotation inside the viewport (Phaser: 0.5). */
  originX: number;
  originY: number;
  zoom: number;
  /** Camera roll, in radians. */
  rotation: number;
};

/** A game object's placement, shaped for `setPosition`/`setRotation`/`setScale`. */
export type ScreenSpaceTransform = {
  x: number;
  y: number;
  rotation: number;
  scale: number;
};

/**
 * Invert `view`, giving the transform under which a game object's local
 * coordinates ARE canvas pixels measured from the canvas's top-left. Apply it
 * to a `scrollFactor(0)` object and what it draws lands where it says it is.
 *
 * Measured off the framebuffer rather than derived (Chrome, Phaser 4.2.1): at
 * bomberman's portrait zoom of 0.81875 an unpinned overlay drew local
 * (309, 768) at canvas (288.6, 706) — 65px away from a 52px hit circle.
 */
export function screenSpaceTransform(view: CameraView): ScreenSpaceTransform {
  const zoom = view.zoom === 0 ? 1 : view.zoom;
  const px = view.width * view.originX;
  const py = view.height * view.originY;
  const cos = Math.cos(view.rotation);
  const sin = Math.sin(view.rotation);
  // Anchored so local (0,0) lands on canvas (0,0): pivot + R(−rot)·(−pivot)/zoom.
  // A uniform scale commutes with the rotation, so one matrix order covers it.
  return {
    x: px - (px * cos + py * sin) / zoom,
    y: py + (px * sin - py * cos) / zoom,
    rotation: -view.rotation,
    scale: 1 / zoom,
  };
}

/**
 * Where to put a *sibling* object — one that carries `transform` itself rather
 * than being parented to the pinned overlay — so its origin lands on canvas
 * point (`x`, `y`).
 */
export function screenSpacePosition(transform: ScreenSpaceTransform, x: number, y: number): Vec2 {
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    x: transform.x + (x * cos - y * sin) * transform.scale,
    y: transform.y + (x * sin + y * cos) * transform.scale,
  };
}
