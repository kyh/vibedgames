import Phaser from "phaser";
import type { BattleBeat } from "./battle-beat";

const SCROLL = 0.22;

/** Three quiet color fields behind the live arena and starfield. */
export class BattleBackdrop {
  private readonly haze: Phaser.GameObjects.Image[];

  constructor(private readonly scene: Phaser.Scene) {
    this.haze = [0x244d86, 0x352765, 0x285260].map((tint) =>
      scene.add
        .image(0, 0, "battle-glow")
        .setDepth(-4)
        .setScrollFactor(SCROLL)
        .setTint(tint)
        .setAlpha(0.18),
    );
    const release = () => {
      scene.events.off(Phaser.Scenes.Events.SHUTDOWN, release);
      scene.events.off(Phaser.Scenes.Events.DESTROY, release);
      this.haze.length = 0;
    };
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, release);
    scene.events.once(Phaser.Scenes.Events.DESTROY, release);
  }

  update(beat: BattleBeat): void {
    const c = this.scene.cameras.main;
    const cx = c.scrollX * SCROLL + c.width / 2;
    const cy = c.scrollY * SCROLL + c.height / 2;
    const w = c.width / c.zoom;
    const h = c.height / c.zoom;
    for (let i = 0; i < this.haze.length; i++) {
      const node = this.haze[i];
      if (!node) continue;
      node
        .setPosition(cx + Math.cos(i * 2.4) * w * 0.3, cy + Math.sin(i * 2.4) * h * 0.25)
        .setDisplaySize(w * 1.3, h * 1.2)
        .setAlpha(beat === "crest" ? 0.2 : beat === "build" ? 0.17 : 0.14);
    }
  }
}
