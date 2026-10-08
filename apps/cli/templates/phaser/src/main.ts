import type { Types } from "phaser";
import { AUTO, Game, Scale } from "phaser";

import { GameScene } from "./scenes/game-scene";

const config: Types.Core.GameConfig = {
  backgroundColor: "#0e1020",
  parent: "game",
  physics: { arcade: { debug: false }, default: "arcade" },
  // A fixed 960×540 world, letterboxed to fit any window.
  scale: { autoCenter: Scale.CENTER_BOTH, height: 540, mode: Scale.FIT, width: 960 },
  scene: [GameScene],
  type: AUTO,
};

export const game = new Game(config);
