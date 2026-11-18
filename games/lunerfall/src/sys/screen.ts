import type Phaser from "phaser";

import { safeAreaInset } from "@vibedgames/gamepad";

export interface GameInset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface CanvasRect {
  left: number;
  top: number;
  right: number;
  k: number;
}

const canvasRect = (scene: Phaser.Scene) => {
  const { displaySize, parentSize, width } = scene.scale;
  const left = Math.max(0, (parentSize.width - displaySize.width) / 2);
  const top = Math.max(0, (parentSize.height - displaySize.height) / 2);

  return {
    k: displaySize.width > 0 ? width / displaySize.width : 1,
    left,
    right: left + displaySize.width,
    top,
  };
};

export const gameInset = (scene: Phaser.Scene) => {
  const ins = safeAreaInset();
  const { left, top, k } = canvasRect(scene);

  return {
    bottom: Math.max(0, ins.bottom - top) * k,
    left: Math.max(0, ins.left - left) * k,
    right: Math.max(0, ins.right - left) * k,
    top: Math.max(0, ins.top - top) * k,
  };
};

export const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

export const isCoarse = () =>
  typeof window !== "undefined" &&
  (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window);

const CLUSTER_SIZE = 44;
const CLUSTER_GAP = 10;

/** Height of the top-right band that cluster covers, in game px — anchor
 *  top-right HUD below it. Zero on a fine pointer, and zero when the FIT
 *  letterbox already keeps the cluster off the canvas (portrait phones). */
export const touchHudBand = (scene: Phaser.Scene) => {
  if (!isCoarse()) {
    return 0;
  }

  const { top, k } = canvasRect(scene);
  const clusterBottom = safeAreaInset().top + CLUSTER_GAP + CLUSTER_SIZE + CLUSTER_GAP;

  return Math.max(0, clusterBottom - top) * k;
};
