import { Scene } from "phaser";
import { notifyGameStarted } from "@repo/embed";

import { ATLAS_KEYS, buildAnimsFromAseprite } from "../data/animations";
import { buildKitClips } from "../data/clip-timing";

interface AnimatedProp {
  key: string;
  frameW: number;
  frameH: number;
  frames: number;
  fps: number;
}

const ANIMATED_PROPS: readonly AnimatedProp[] = [
  { fps: 10, frameH: 144, frameW: 144, frames: 13, key: "blue-fountain" },
  { fps: 10, frameH: 64, frameW: 64, frames: 6, key: "blue-campfire" },
  { fps: 12, frameH: 144, frameW: 144, frames: 6, key: "blue-columnfire" },
  { fps: 8, frameH: 144, frameW: 144, frames: 13, key: "blue-flag" },
];

export class BootScene extends Scene {
  constructor() {
    super("boot");
  }

  preload() {
    for (const key of ATLAS_KEYS) {
      this.load.aseprite(key, `sprites/ase/${key}.webp`, `sprites/ase/${key}.json`);
    }

    for (const img of ["tiles", "props", "backdrop", "bamboo", "bushes", "rocks", "tree"]) {
      this.load.image(`env:${img}`, `sprites/env/${img}.webp`);
    }

    for (const prop of ANIMATED_PROPS) {
      this.load.spritesheet(`prop:${prop.key}`, `sprites/props/${prop.key}.webp`, {
        frameHeight: prop.frameH,
        frameWidth: prop.frameW,
      });
    }

    this.load.spritesheet("fx:flame-wave", "sprites/fx/flame-wave.webp", {
      frameHeight: 16,
      frameWidth: 182,
    });
    this.load.image("fx:arrow", "sprites/fx/arrow.webp");
  }

  create() {
    for (const key of ATLAS_KEYS) {
      buildAnimsFromAseprite(this, key);
    }

    buildKitClips(this);

    this.anims.create({
      frameRate: 16,
      frames: this.anims.generateFrameNumbers("fx:flame-wave", {}),
      key: "fx:flame-wave",
      repeat: -1,
    });

    for (const prop of ANIMATED_PROPS) {
      this.anims.create({
        frameRate: prop.fps,
        frames: this.anims.generateFrameNumbers(`prop:${prop.key}`, {
          end: prop.frames - 1,
          start: 0,
        }),
        key: `prop:${prop.key}`,
        repeat: -1,
      });
    }

    const params = new URLSearchParams(location.search);

    if (params.has("viewer")) {
      void (async () => {
        const { ViewerScene } = await import("./viewer-scene");

        if (!this.scene.manager.getScene("viewer")) {
          this.scene.add("viewer", ViewerScene);
        }

        this.scene.start("viewer");
      })();
    } else if (
      params.get("demo") ||
      params.get("room") ||
      params.get("hero") ||
      params.has("trailer")
    ) {
      notifyGameStarted();
      this.scene.start("game");
    } else {
      this.scene.start("select");
    }
  }
}
