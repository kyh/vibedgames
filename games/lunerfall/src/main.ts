import Phaser from "phaser";

import { BASE_H, BASE_W } from "./config";
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
