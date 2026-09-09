import type Phaser from "phaser";
import type { BattleBeat } from "./battle-beat";

const SCROLL = 0.22;

/** Three quiet color fields behind the live arena and starfield. */
export class BattleBackdrop {
  private readonly haze: Phaser.GameObjects.Image[];

  constructor(private readonly scene: Phaser.Scene) {
    this.haze = [0x24_4d_86, 0x35_27_65, 0x28_52_60].map((tint) =>
      scene.add
        .image(0, 0, "battle-glow")
        .setDepth(-4)
        .setScrollFactor(SCROLL)
        .setTint(tint)
        .setAlpha(0.18),
    );
  }

  update(beat: BattleBeat): void {
    const c = this.scene.cameras.main;
    const cx = c.scrollX * SCROLL + c.width / 2;
    const cy = c.scrollY * SCROLL + c.height / 2;
    const w = c.width / c.zoom;
    const h = c.height / c.zoom;
    const alpha = beat === "crest" ? 0.2 : beat === "build" ? 0.17 : 0.14;
    this.haze.forEach((node, i) =>
      node
        .setPosition(cx + Math.cos(i * 2.4) * w * 0.3, cy + Math.sin(i * 2.4) * h * 0.25)
        .setDisplaySize(w * 1.3, h * 1.2)
        .setAlpha(alpha),
    );
  }
}
