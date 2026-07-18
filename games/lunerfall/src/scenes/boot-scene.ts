import Phaser from "phaser";
import { notifyGameStarted } from "@repo/embed";

import { ATLAS_KEYS, buildAnimsFromAseprite } from "../data/animations";
import { buildKitClips } from "../data/clip-timing";

// Loads every character/enemy/boss as an Aseprite atlas (texture + tag/duration
// JSON), builds animations with the authored per-frame timings, loads the
// environment art + fx textures, then routes to the hub (or straight into a run
// for the debug params).
export class BootScene extends Phaser.Scene {
  constructor() {
    super("boot");
  }

  preload() {
    for (const key of ATLAS_KEYS) {
      this.load.aseprite(key, `sprites/ase/${key}.png`, `sprites/ase/${key}.json`);
    }

    // Environment art: static tiles/props + backdrop.
    for (const img of ["tiles", "props", "backdrop", "bamboo", "bushes", "rocks", "tree"]) {
      this.load.image(`env:${img}`, `sprites/env/${img}.png`);
    }
    for (const [key, w, h] of ANIMATED_PROPS) {
      this.load.spritesheet(`prop:${key}`, `sprites/props/${key}.png`, {
        frameWidth: w,
        frameHeight: h,
      });
    }

    // Projectiles.
    this.load.spritesheet("fx:flame-wave", "sprites/fx/flame-wave.png", {
      frameWidth: 182,
      frameHeight: 16,
    });
    this.load.image("fx:arrow", "sprites/fx/arrow.png");
  }

  create() {
    for (const key of ATLAS_KEYS) buildAnimsFromAseprite(this, key);
    buildKitClips(this); // hero attack variants retimed so contact frames match hitboxes

    this.anims.create({
      key: "fx:flame-wave",
      frames: this.anims.generateFrameNumbers("fx:flame-wave", {}),
      frameRate: 16,
      repeat: -1,
    });
    for (const [key, , , frames, fps] of ANIMATED_PROPS) {
      this.anims.create({
        key: `prop:${key}`,
        frames: this.anims.generateFrameNumbers(`prop:${key}`, { start: 0, end: frames - 1 }),
        frameRate: fps,
        repeat: -1,
      });
    }

    const params = new URLSearchParams(location.search);
    // ?viewer — animation viewer (scenes/viewer-scene.ts). Lazy import so the
    // viewer never ships in the main game chunk; dedupe the add because scene
    // instances persist across start/stop in Phaser 4.
    if (params.has("viewer")) {
      void import("./viewer-scene").then(({ ViewerScene }) => {
        if (!this.scene.manager.getScene("viewer")) this.scene.add("viewer", ViewerScene);
        return this.scene.start("viewer");
      });
    } else if (
      params.get("demo") ||
      params.get("room") ||
      params.get("hero") ||
      params.has("trailer") // trailer mode boots straight into a solo run (src/trailer)
    ) {
      notifyGameStarted();
      this.scene.start("game");
    } else this.scene.start("select");
  }
}

// Animated shrine props (blue = ambient theme): [key, frameW, frameH, frames, fps].
const ANIMATED_PROPS: readonly [string, number, number, number, number][] = [
  ["blue-fountain", 144, 144, 13, 10],
  ["blue-campfire", 64, 64, 6, 10],
  ["blue-columnfire", 144, 144, 6, 12],
  ["blue-flag", 144, 144, 13, 8],
];
