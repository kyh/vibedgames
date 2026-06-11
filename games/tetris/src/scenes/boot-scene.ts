import Phaser from "phaser";

import { BLOCK } from "../shared/constants";

export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    this.makeUtilTextures();
  }

  create(): void {
    this.scene.start("Game");
  }

  /** All art is procedural: a tintable beveled block plus a soft particle. */
  private makeUtilTextures(): void {
    const g = this.add.graphics();

    // Beveled block, drawn in grayscale so per-piece tint supplies the color:
    // white top/left edge, slightly darker inner face, darkest bottom/right.
    const b = BLOCK;
    const edge = Math.max(2, Math.floor(b / 8));
    g.fillStyle(0xffffff, 1).fillRect(1, 1, b - 2, b - 2);
    g.fillStyle(0x000000, 0.12).fillRect(1 + edge, 1 + edge, b - 2 - edge * 2, b - 2 - edge * 2);
    g.fillStyle(0x000000, 0.32).fillRect(1, b - 1 - edge, b - 2, edge);
    g.fillStyle(0x000000, 0.32).fillRect(b - 1 - edge, 1, edge, b - 2);
    g.generateTexture("block", b, b);
    g.clear();

    // Soft round particle (concentric falloff) for drop dust and clear sparks.
    for (let i = 6; i >= 1; i--) {
      g.fillStyle(0xffffff, 0.18).fillCircle(16, 16, (i / 6) * 14);
    }
    g.generateTexture("spark", 32, 32);
    g.destroy();
  }
}
