import Phaser from "phaser";

import { BootScene } from "./scenes/boot-scene";
import { GameScene } from "./scenes/game-scene";

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
