import Phaser from "phaser";

import { BootScene } from "./scenes/BootScene";
import { TitleScene } from "./scenes/TitleScene";
import { GameScene } from "./scenes/GameScene";
import { MineScene } from "./scenes/MineScene";
import { MineHudScene } from "./scenes/MineHudScene";
import { HudScene } from "./scenes/HudScene";
import { InventoryScene } from "./scenes/InventoryScene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#1c2030",
  scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
  pixelArt: true,
  roundPixels: true,
  physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  scene: [BootScene, TitleScene, GameScene, MineScene, MineHudScene, HudScene, InventoryScene],
};

new Phaser.Game(config);
