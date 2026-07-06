import Phaser from "phaser";

import { HERO_ORIGIN_Y } from "../config";
import type { Grid } from "../sys/grid";
import { BossBody } from "./boss-body";

const SCALE = 2.1;

// Phaser view over BossBody: bigger salamander sprite, state-driven clips, a red
// telegraph tint on wind-ups, and a white hit-flash.
export class Boss {
  readonly body: BossBody;
  readonly sprite: Phaser.GameObjects.Sprite;
  private tinted = false;

  constructor(scene: Phaser.Scene, grid: Grid, x: number, y: number, biome: number) {
    this.body = new BossBody(grid, x, y, biome);
    this.sprite = scene.add.sprite(x, y, "salamander:idle").setOrigin(0.5, HERO_ORIGIN_Y).setScale(SCALE).setDepth(12);
    this.sprite.play("salamander:idle");
  }

  private clip(): string {
    const b = this.body;
    switch (b.state) {
      case "dead":
        return "death";
      case "wave":
        return "flame-wave";
      case "jump":
      case "slam":
        return "flame-slam";
      case "punch":
        return "fire-punch";
      case "hurt":
        return "hit";
      default:
        return Math.abs(b.vx) > 12 ? "run" : "idle";
    }
  }

  render() {
    const b = this.body;
    this.sprite.play(`salamander:${this.clip()}`, true);
    this.sprite.setFlipX(b.facing < 0);
    this.sprite.setPosition(Math.round(b.x), Math.round(b.y));
    if (b.hitFlash > 0) {
      this.sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
      this.tinted = true;
    } else if (b.telegraphing) {
      this.sprite.setTint(0xff7a3d).setTintMode(Phaser.TintModes.MULTIPLY);
      this.tinted = true;
    } else if (this.tinted) {
      this.sprite.clearTint().setTintMode(Phaser.TintModes.MULTIPLY);
      this.tinted = false;
    }
  }

  destroy() {
    this.sprite.destroy();
  }
}
