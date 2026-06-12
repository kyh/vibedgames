import Phaser from "phaser";

import { BIRD_FLAP_FPS, DRAGON_SKINS } from "../shared/constants";

export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    this.makeUtilTextures();

    // Game art, flat in public/ (loaded by relative URL).
    for (let n = 1; n <= DRAGON_SKINS; n++) {
      for (let f = 1; f <= 4; f++) {
        this.load.image(`dragon-${n}-${f}`, `dragon-${n}-${f}.png`);
      }
    }
    for (let i = 1; i <= 4; i++) this.load.image(`bg-${i}`, `bg-${i}.png`);
    this.load.image("tube-cap", "tube-cap.png");
    this.load.image("tube-body", "tube-body.png");
    for (let i = 1; i <= 6; i++) this.load.image(`coin-${i}`, `coin-${i}.png`);
    for (let i = 1; i <= 8; i++) this.load.image(`burst-${i}`, `burst-${i}.png`);
    this.load.spritesheet("digits", "digits.png", { frameWidth: 16, frameHeight: 16 });
    this.load.image("msg-ready", "msg-ready.png");
    this.load.image("msg-gameover", "msg-gameover.png");

    this.load.audio("point", "point.wav");
    this.load.audio("hit", "hit.wav");
    this.load.audio("flap", "flap.wav");
  }

  create(): void {
    // One wing cycle per skin across its four single-frame textures.
    for (let n = 1; n <= DRAGON_SKINS; n++) {
      this.anims.create({
        key: `fly-${n}`,
        frames: [1, 2, 3, 4].map((f) => ({ key: `dragon-${n}-${f}` })),
        frameRate: BIRD_FLAP_FPS,
        repeat: -1,
      });
    }

    this.anims.create({
      key: "coin-spin",
      frames: [1, 2, 3, 4, 5, 6].map((f) => ({ key: `coin-${f}` })),
      frameRate: 10,
      repeat: -1,
    });

    this.anims.create({
      key: "burst",
      frames: [1, 2, 3, 4, 5, 6, 7, 8].map((f) => ({ key: `burst-${f}` })),
      frameRate: 24,
      repeat: 0,
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
