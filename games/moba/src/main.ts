import Phaser from "phaser";
import { setPauseHandlers } from "@vibedgames/embed";

import { BootScene } from "./scenes/boot-scene";
import { GalleryScene } from "./scenes/gallery-scene";
import { GameScene } from "./scenes/game-scene";
import { HudScene } from "./scenes/hud-scene";
import { MenuScene } from "./scenes/menu-scene";
import { ShowcaseScene } from "./scenes/showcase-scene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#0a0e16",
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: "100%",
    height: "100%",
  },
  pixelArt: true,
  roundPixels: true,
  // GameScene owns its own pointer handling; disable the right-click menu so
  // right-click can drive move orders the way a MOBA expects.
  disableContextMenu: true,
  scene: [BootScene, MenuScene, GameScene, HudScene, GalleryScene, ShowcaseScene],
};

// The display font must be resolved before any Phaser Text is created, or those
// texts rasterise with the fallback. Cap the wait so a blocked font CDN can
// never hold the game hostage.
const fontReady = Promise.race([
  document.fonts.load('20px "Lilita One"'),
  new Promise((resolve) => setTimeout(resolve, 1500)),
]);
declare global {
  interface Window {
    /** DEV-only hook for headless verification. */
    __game?: Phaser.Game;
  }
}

void fontReady.then(() => {
  const game = new Phaser.Game(config);
  if (import.meta.env.DEV) window.__game = game;
  // Scale.RESIZE can read stale parent bounds when the browser delivers a
  // single resize event (phone rotation): the canvas lags one size behind.
  // Re-check once the layout settles.
  let settle: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(settle);
    settle = setTimeout(() => game.scale.refresh(), 150);
  });

  // Sim is entirely delta-driven (update(_t, deltaMs)), so the wrapper's
  // pause can freeze/resume the loop directly — except in online mode, where
  // freezing the host would stall every client. `froze` ensures onResume only
  // wakes what onPause put to sleep.
  const isOnline = (): boolean => {
    const scene = game.scene.getScene("Game");
    return game.scene.isActive("Game") && scene instanceof GameScene && scene.isOnline();
  };
  let froze = false;
  setPauseHandlers({
    onPause: () => {
      if (isOnline()) return;
      froze = true;
      game.loop.sleep();
      game.sound.pauseAll();
    },
    onResume: () => {
      if (!froze) return;
      froze = false;
      game.loop.wake();
      game.sound.resumeAll();
    },
  });
});
