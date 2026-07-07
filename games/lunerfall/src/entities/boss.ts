import Phaser from "phaser";

import { HERO_ORIGIN_Y, interp } from "../config";
import { bossKind } from "../data/bosses";
import type { Grid } from "../sys/grid";
import { BossBody } from "./boss-body";

const SCALE = 2.1;

// Phaser view over BossBody: bigger salamander sprite recoloured per biome,
// state-driven clips, a red telegraph tint on wind-ups, and a white hit-flash.
export class Boss {
  readonly body: BossBody;
  readonly sprite: Phaser.GameObjects.Sprite;
  private readonly baseTint: number; // per-biome recolour, applied when idle

  constructor(scene: Phaser.Scene, grid: Grid, x: number, y: number, biome: number) {
    this.body = new BossBody(grid, x, y, biome);
    this.baseTint = bossKind(biome).tint;
    this.sprite = scene.add
      .sprite(x, y, "salamander")
      .setOrigin(0.5, HERO_ORIGIN_Y)
      .setScale(SCALE)
      .setDepth(12)
      .setTint(this.baseTint);
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
      case "charge":
        return "run";
      case "punch":
        return "fire-punch";
      case "hurt":
        return "hit";
      default:
        return Math.abs(b.vx) > 12 ? "run" : "idle";
    }
  }

  // White fill on hit, orange multiply on wind-up, else the biome recolour.
  private applyTint(flash: boolean, telegraph: boolean) {
    if (flash) this.sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    else if (telegraph) this.sprite.setTint(0xff7a3d).setTintMode(Phaser.TintModes.MULTIPLY);
    else this.sprite.setTint(this.baseTint).setTintMode(Phaser.TintModes.MULTIPLY);
  }

  render(alpha = 1) {
    const b = this.body;
    this.sprite.play(`salamander:${this.clip()}`, true);
    this.sprite.setFlipX(b.facing < 0);
    this.sprite.setPosition(
      Math.round(interp(b.prevX, b.x, alpha)),
      Math.round(interp(b.prevY, b.y, alpha)),
    );
    this.applyTint(b.hitFlash > 0, b.telegraphing);
  }

  // Guest: replay the host's clip on this puppet (no local sim/state). Position
  // lerps toward the authoritative point so 30Hz snapshots render smoothly.
  applyNet(clip: string, x: number, y: number, flip: boolean, flash: boolean, telegraph: boolean) {
    if (this.sprite.anims.currentAnim?.key !== clip) this.sprite.play(clip, true);
    this.sprite.setFlipX(flip);
    const far = Math.hypot(x - this.sprite.x, y - this.sprite.y) > 48;
    this.sprite.setPosition(
      far ? x : this.sprite.x + (x - this.sprite.x) * 0.35,
      far ? y : this.sprite.y + (y - this.sprite.y) * 0.35,
    );
    this.applyTint(flash, telegraph);
  }

  destroy() {
    this.sprite.destroy();
  }
}
