import { Scene } from "phaser";

/**
 * No loaded assets — the whole game is procedural vector art. Boot only
 * generates utility textures for the vector battle's light and starfield.
 */
export class BootScene extends Scene {
  constructor() {
    super("Boot");
  }

  preload() {
    const g = this.add.graphics();

    g.fillStyle(0xff_ff_ff, 1).fillRect(0, 0, 5, 5);
    g.generateTexture("star", 5, 5);
    g.clear();

    for (let i = 6; i >= 1; i -= 1) {
      g.fillStyle(0xff_ff_ff, 0.18).fillCircle(16, 16, (i / 6) * 14);
    }

    g.generateTexture("spark", 32, 32);
    g.clear();

    for (let r = 32; r >= 1; r -= 1) {
      const t = 1 - r / 32;
      g.fillStyle(0xff_ff_ff, 0.015 + t * t * 0.035).fillCircle(32, 32, r);
    }

    g.generateTexture("battle-glow", 64, 64);
    g.destroy();
  }

  create() {
    this.scene.start("Game");
  }
}
