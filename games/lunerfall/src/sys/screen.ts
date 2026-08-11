import type Phaser from "phaser";

import { safeAreaInset } from "@vibedgames/gamepad";

export type GameInset = { top: number; right: number; bottom: number; left: number };

// Where the canvas actually sits on the page, in CSS px, plus the game-px per
// CSS-px factor. Scale.FIT + CENTER_BOTH letterboxes the canvas inside #game
// (which is `inset: 0`), so screen-anchored things — notches, DOM overlays —
// only reach the game by however far they intrude past the letterbox margin.
type CanvasRect = { left: number; top: number; right: number; k: number };

function canvasRect(scene: Phaser.Scene): CanvasRect {
  const { displaySize, parentSize, width } = scene.scale;
  const left = Math.max(0, (parentSize.width - displaySize.width) / 2);
  const top = Math.max(0, (parentSize.height - displaySize.height) / 2);
  return {
    left,
    top,
    right: left + displaySize.width,
    k: displaySize.width > 0 ? width / displaySize.width : 1,
  };
}

// Safe-area insets converted to game-space px for HUD layout.
export function gameInset(scene: Phaser.Scene): GameInset {
  const ins = safeAreaInset();
  const { left, top, k } = canvasRect(scene);
  return {
    top: Math.max(0, ins.top - top) * k,
    right: Math.max(0, ins.right - left) * k,
    bottom: Math.max(0, ins.bottom - top) * k,
    left: Math.max(0, ins.left - left) * k,
  };
}

// @repo/embed's touch pause/mute cluster is fixed to the top-right of the PAGE,
// so on a landscape phone it lands on top of whatever the game anchors to its
// own top-right. These mirror createTouchControls' geometry (44px buttons, 10px
// gap). Dodging it downward rather than sideways: these HUD lines are short and
// the space under them is empty, while sideways runs them into centred titles.
const CLUSTER_SIZE = 44;
const CLUSTER_GAP = 10;

/** Height of the top-right band that cluster covers, in game px — anchor
 *  top-right HUD below it. Zero on a fine pointer, and zero when the FIT
 *  letterbox already keeps the cluster off the canvas (portrait phones). */
export function touchHudBand(scene: Phaser.Scene): number {
  if (!isCoarse()) return 0;
  const { top, k } = canvasRect(scene);
  const clusterBottom = safeAreaInset().top + CLUSTER_GAP + CLUSTER_SIZE + CLUSTER_GAP;
  return Math.max(0, clusterBottom - top) * k;
}

// Touch-first device, decided at boot (not after the first touch) so hint copy
// and tap targets are right from the first frame.
export const isCoarse = (): boolean =>
  typeof window !== "undefined" &&
  (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window);
