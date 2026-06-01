import Phaser from "phaser";

import { BootScene } from "./scenes/BootScene";
import { GameScene } from "./scenes/GameScene";
import { GRID_COLS, GRID_ROWS, TILE } from "./shared/constants";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#1a1a2e",
  width: GRID_COLS * TILE,
  height: GRID_ROWS * TILE,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  pixelArt: true,
  scene: [BootScene, GameScene],
};

new Phaser.Game(config);
