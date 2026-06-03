import Phaser from "phaser";

import { BootScene } from "./scenes/BootScene";
import { GameScene } from "./scenes/GameScene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#0e1020",
  scale: {
    // Fill the window; GameScene owns the follow-camera + zoom.
    mode: Phaser.Scale.RESIZE,
    width: "100%",
    height: "100%",
  },
  pixelArt: true,
  scene: [BootScene, GameScene],
};

new Phaser.Game(config);
