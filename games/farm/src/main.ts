import Phaser from "phaser";
import { setPauseHandlers } from "@vibedgames/embed";

import { BootScene } from "./scenes/boot-scene";
import { TitleScene } from "./scenes/title-scene";
import { GameScene } from "./scenes/game-scene";
import { MineScene } from "./scenes/mine-scene";
import { MineHudScene } from "./scenes/mine-hud-scene";
import { HudScene } from "./scenes/hud-scene";
import { InventoryScene } from "./scenes/inventory-scene";
import { GalleryScene } from "./scenes/gallery-scene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#1c2030",
  scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
  pixelArt: true,
  roundPixels: true,
  physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  scene: [
    BootScene,
    TitleScene,
    GameScene,
    MineScene,
    MineHudScene,
    HudScene,
    InventoryScene,
    GalleryScene,
  ],
};

declare global {
  interface Window {
    /** DEV-only hook for headless verification. */
    __game?: Phaser.Game;
  }
}

const game = new Phaser.Game(config);
if (import.meta.env.DEV) window.__game = game;

// Sim is entirely delta-driven (update(_t, dms)), so the wrapper's pause can
// freeze/resume the loop directly — except in live co-op, where freezing would
// stall heartbeats and desync the room. `froze` ensures onResume only wakes
// what onPause put to sleep.
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
