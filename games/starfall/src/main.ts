import Phaser from "phaser";

import { BootScene } from "./scenes/boot-scene";
import { GameScene } from "./scenes/game-scene";
import { reseed } from "./shared/rng";
import { isTrailerMode } from "./trailer/trailer-shell";

// Bot-playtest seeding (boot-time variant of the diagnostics contract — see
// shared/diag.ts): the scene is single-start, so the seed must land before
// any gameplay roll rather than via a mid-run hook.
const seedParam = new URLSearchParams(location.search).get("seed");
if (seedParam !== null && seedParam !== "" && Number.isFinite(Number(seedParam))) {
  reseed(Number(seedParam));
} else if (isTrailerMode()) {
  // Trailer runs seed the gameplay stream so takes are repeatable.
  reseed(7);
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  // Transparent canvas: the page's tiled bg.png texture shows through inside
  // the world; the out-of-bounds mask still paints opaque.
  transparent: true,
  scale: {
    // Fill the window; GameScene owns the hard-centered follow camera.
    mode: Phaser.Scale.RESIZE,
    width: "100%",
    height: "100%",
  },
  scene: [BootScene, GameScene],
};

declare global {
  interface Window {
    /** DEV-only hook for headless verification. */
    __game?: Phaser.Game;
  }
}

const game = new Phaser.Game(config);
if (import.meta.env.DEV) window.__game = game;

// Trailer mode (?trailer=1): hand the booted game to the director, which
// stages a scripted, letterboxed gameplay trailer over a forced-offline
// session (GameScene skips the socket under this flag). Lazy import — the
// director/shell UI never loads in normal play.
if (isTrailerMode()) {
  void import("./trailer/trailer-director").then(({ bootTrailerDirector }) =>
    bootTrailerDirector(game),
  );
}

// Scale.RESIZE can read stale parent bounds when a resize lands while the tab
// is hidden or the browser throttles events (tab switch, phone rotation): the
// canvas lags one size behind. Re-check once layout settles and on tab return.
let settle: ReturnType<typeof setTimeout> | undefined;
const refreshScale = (): void => {
  clearTimeout(settle);
  settle = setTimeout(() => game.scale.refresh(), 150);
};
window.addEventListener("resize", refreshScale);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshScale();
});
