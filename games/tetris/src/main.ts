import Phaser from "phaser";

import { BootScene } from "./scenes/boot-scene";
import { GameScene } from "./scenes/game-scene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#1a1a1a",
  scale: {
    // Fill the window; GameScene scales/centers the playfield itself.
    mode: Phaser.Scale.RESIZE,
    width: "100%",
    height: "100%",
  },
  scene: [BootScene, GameScene],
};

new Phaser.Game(config);
