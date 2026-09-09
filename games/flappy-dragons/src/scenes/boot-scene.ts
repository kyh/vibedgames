import { Scene } from "phaser";

import { BIRD_FLAP_FPS, DRAGON_SKINS } from "../shared/constants";

export class BootScene extends Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    this.makeUtilTextures();

    // Game art, flat in public/ (loaded by relative URL).
    for (let n = 1; n <= DRAGON_SKINS; n += 1) {
      for (let f = 1; f <= 4; f += 1) {
        this.load.image(`dragon-${n}-${f}`, `dragon-${n}-${f}.png`);
      }
    }
    for (let i = 1; i <= 4; i += 1) {
      this.load.image(`bg-${i}`, `bg-${i}.png`);
    }
    this.load.image("tube-cap", "tube-cap.png");
    this.load.image("tube-body", "tube-body.png");
    for (let i = 1; i <= 6; i += 1) {
      this.load.image(`coin-${i}`, `coin-${i}.png`);
    }
    for (let i = 1; i <= 8; i += 1) {
      this.load.image(`burst-${i}`, `burst-${i}.png`);
    }
    this.load.spritesheet("digits", "digits.png", { frameHeight: 16, frameWidth: 16 });
    this.load.image("msg-ready", "msg-ready.png");
    this.load.image("msg-gameover", "msg-gameover.png");

    // Opus first, AAC for Safari (Phaser picks the first the device reports it
    // can play). The WAVs these replace were 296KB — 38% of the whole download
    // — for three sub-second effects.
    for (const sfx of ["point", "hit", "flap"]) {
      this.load.audio(sfx, [`${sfx}.webm`, `${sfx}.m4a`]);
    }
  }

  create(): void {
    // One wing cycle per skin across its four single-frame textures.
    for (let n = 1; n <= DRAGON_SKINS; n += 1) {
      this.anims.create({
        frameRate: BIRD_FLAP_FPS,
        frames: [1, 2, 3, 4].map((f) => ({ key: `dragon-${n}-${f}` })),
        key: `fly-${n}`,
        repeat: -1,
      });
    }

    this.anims.create({
      frameRate: 10,
      frames: [1, 2, 3, 4, 5, 6].map((f) => ({ key: `coin-${f}` })),
      key: "coin-spin",
      repeat: -1,
    });

    this.anims.create({
      frameRate: 24,
      frames: [1, 2, 3, 4, 5, 6, 7, 8].map((f) => ({ key: `burst-${f}` })),
      key: "burst",
      repeat: 0,
    });

    this.scene.start("Game");
  }

  /** Soft round particle for score puffs (concentric falloff). */
  private makeUtilTextures(): void {
    const g = this.add.graphics();
    for (let i = 6; i >= 1; i -= 1) {
      g.fillStyle(0xff_ff_ff, 0.18).fillCircle(16, 16, (i / 6) * 14);
    }
    g.generateTexture("spark", 32, 32);
    g.destroy();
  }
}
