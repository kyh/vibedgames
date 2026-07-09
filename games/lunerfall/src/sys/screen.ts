import type Phaser from "phaser";

import { safeAreaInset } from "@vibedgames/gamepad";

export type GameInset = { top: number; right: number; bottom: number; left: number };

// CSS-px safe-area insets converted to game-space px for HUD layout. The canvas
// fills the screen (FIT with a window-derived aspect), so display px map to
// game px by a single scale factor.
export function gameInset(scene: Phaser.Scene): GameInset {
  const ins = safeAreaInset();
  const dw = scene.scale.displaySize.width;
  const k = dw > 0 ? scene.scale.width / dw : 1;
  return { top: ins.top * k, right: ins.right * k, bottom: ins.bottom * k, left: ins.left * k };
}

// Touch-first device, decided at boot (not after the first touch) so hint copy
// and tap targets are right from the first frame.
export const isCoarse = (): boolean =>
  typeof window !== "undefined" &&
  (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window);
