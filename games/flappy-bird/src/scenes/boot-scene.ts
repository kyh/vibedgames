import Phaser from "phaser";

import { BIRD_FLAP_FPS } from "../shared/constants";

export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    this.makeUtilTextures();

    // Classic sprite pack, flat in public/ (loaded by relative URL).
    this.load.image("background", "background.png");
    this.load.image("pipe", "pipe.png");
    this.load.image("ready", "ready.png");
    this.load.image("gameover", "gameover.png");
    this.load.image("bird-down", "bird-down.png");
    this.load.image("bird-mid", "bird-mid.png");
    this.load.image("bird-up", "bird-up.png");
    for (let d = 0; d <= 9; d++) this.load.image(`digit-${d}`, `${d}.png`);

    this.load.audio("point", "point.wav");
    this.load.audio("hit", "hit.wav");
    this.load.audio("flap", "flap.wav");
  }

  create(): void {
    // Wing cycle across the three single-frame textures: down → mid → up → mid.
    this.anims.create({
      key: "flap",
      frames: [{ key: "bird-down" }, { key: "bird-mid" }, { key: "bird-up" }, { key: "bird-mid" }],
      frameRate: BIRD_FLAP_FPS,
      repeat: -1,
    });

    this.scene.start("Game");
  }

  /** Soft round particle for score puffs (concentric falloff). */
  private makeUtilTextures(): void {
    const g = this.add.graphics();
    for (let i = 6; i >= 1; i--) {
      g.fillStyle(0xffffff, 0.18).fillCircle(16, 16, (i / 6) * 14);
    }
    g.generateTexture("spark", 32, 32);
    g.destroy();
  }
}
