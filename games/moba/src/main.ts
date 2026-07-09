import Phaser from "phaser";

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
void fontReady.then(() => {
  const game = new Phaser.Game(config);
  // Scale.RESIZE can read stale parent bounds when the browser delivers a
  // single resize event (phone rotation): the canvas lags one size behind.
  // Re-check once the layout settles.
  let settle: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(settle);
    settle = setTimeout(() => game.scale.refresh(), 150);
  });
});
