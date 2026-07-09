import Phaser from "phaser";

import { BASE_H, BASE_W, clampAspect } from "./config";
import { BootScene } from "./scenes/boot-scene";
import { EditorScene } from "./scenes/editor-scene";
import { GameScene } from "./scenes/game-scene";
import { SelectScene } from "./scenes/select-scene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#05070b",
  pixelArt: true,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: BASE_W,
    height: BASE_H,
  },
  scene: [BootScene, SelectScene, GameScene, EditorScene],
};

const game = new Phaser.Game(config);
// Debug handle for perf/inspection probes (see globalThis.__game).
Reflect.set(globalThis, "__game", game);

// BASE_W bakes the load-time aspect into every scene's layout, so a rotation
// (or any resize that lands on a materially different clamped aspect) can only
// re-fit via a reload. Debounced, and gated on the clamped ratio actually
// moving, so browser-chrome resize noise can't loop reloads: after a reload
// the baked aspect equals the live one and the check goes quiet.
const bakedAspect = BASE_W / BASE_H;
let aspectTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  clearTimeout(aspectTimer);
  aspectTimer = setTimeout(() => {
    if (window.innerHeight <= 0) return;
    const live = clampAspect(window.innerWidth / window.innerHeight);
    if (Math.abs(live - bakedAspect) / bakedAspect > 0.2) location.reload();
  }, 400);
});
