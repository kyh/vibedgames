import Phaser from "phaser";

import { ENEMY_FRAME, HERO_FRAME } from "../config";
import { clipFps, clipLoops, ENEMY_CLIPS, HERO_CLIPS } from "../data/animations";

// Loads every sheet as a spritesheet, registers a Phaser animation per clip,
// then hands off to the game. Frame counts come straight from the textures.
export class BootScene extends Phaser.Scene {
  constructor() {
    super("boot");
  }

  preload() {
    for (const [hero, clips] of Object.entries(HERO_CLIPS)) {
      for (const clip of clips) {
        this.load.spritesheet(`${hero}:${clip}`, `sprites/heroes/${hero}/${clip}.png`, {
          frameWidth: HERO_FRAME,
          frameHeight: HERO_FRAME,
        });
      }
    }
    for (const [enemy, clips] of Object.entries(ENEMY_CLIPS)) {
      for (const clip of clips) {
        this.load.spritesheet(`${enemy}:${clip}`, `sprites/enemies/${enemy}/${clip}.png`, {
          frameWidth: ENEMY_FRAME,
          frameHeight: ENEMY_FRAME,
        });
      }
    }

    // Environment art (used by the tilemap / room dressing later).
    for (const img of ["tiles", "props", "background", "bamboo", "bushes", "rocks", "tree"]) {
      this.load.image(`env:${img}`, `sprites/env/${img}.png`);
    }

    // Projectiles with non-square frames.
    this.load.spritesheet("fx:flame-wave", "sprites/heroes/salamander/wave-projectile.png", {
      frameWidth: 182,
      frameHeight: 16,
    });
    this.load.image("fx:arrow", "sprites/enemies/archer/custom-arrow.png");
  }

  create() {
    const register = (who: string, clips: readonly string[]) => {
      for (const clip of clips) {
        const key = `${who}:${clip}`;
        if (this.anims.exists(key)) continue;
        this.anims.create({
          key,
          frames: this.anims.generateFrameNumbers(key, {}),
          frameRate: clipFps(clip),
          repeat: clipLoops(clip) ? -1 : 0,
        });
      }
    };
    for (const [hero, clips] of Object.entries(HERO_CLIPS)) register(hero, clips);
    for (const [enemy, clips] of Object.entries(ENEMY_CLIPS)) register(enemy, clips);

    this.anims.create({
      key: "fx:flame-wave",
      frames: this.anims.generateFrameNumbers("fx:flame-wave", {}),
      frameRate: 16,
      repeat: -1,
    });

    // Debug params (?demo / ?room / ?hero) jump straight into a run.
    const params = new URLSearchParams(location.search);
    if (params.get("demo") || params.get("room") || params.get("hero")) this.scene.start("game");
    else this.scene.start("select");
  }
}
