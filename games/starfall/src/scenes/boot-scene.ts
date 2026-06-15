import Phaser from "phaser";

/**
 * No loaded assets — the whole game is procedural vector art. Boot only
 * generates the two utility textures the FX + starfield need.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    const g = this.add.graphics();

    // "star": solid 5×5 white square (tinted per star).
    g.fillStyle(0xffffff, 1).fillRect(0, 0, 5, 5);
    g.generateTexture("star", 5, 5);
    g.clear();

    // "spark": concentric-falloff soft dot for hit/pickup bursts.
    for (let i = 6; i >= 1; i--) {
      g.fillStyle(0xffffff, 0.18).fillCircle(16, 16, (i / 6) * 14);
    }
    g.generateTexture("spark", 32, 32);
    g.destroy();
  }

  create(): void {
    this.scene.start("Game");
  }
}
