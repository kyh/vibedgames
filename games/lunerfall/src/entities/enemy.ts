import Phaser from "phaser";

import { ENEMY_ORIGIN_Y, ENEMY_SCALE } from "../config";
import type { EnemyKind } from "../data/enemies";
import type { Grid } from "../sys/grid";
import { EnemyBody } from "./enemy-body";

// Phaser view over EnemyBody: picks the animation clip from the sim state and
// renders a white hit-flash.
export class Enemy {
  readonly body: EnemyBody;
  readonly sprite: Phaser.GameObjects.Sprite;
  private flashing = false;

  constructor(scene: Phaser.Scene, grid: Grid, kind: EnemyKind, x: number, y: number) {
    this.body = new EnemyBody(kind, grid, x, y);
    this.sprite = scene.add.sprite(x, y, kind.name);
    this.sprite.setOrigin(0.5, ENEMY_ORIGIN_Y).setScale(ENEMY_SCALE);
    this.sprite.play(`${kind.name}:spawn`);
  }

  private clip(): string {
    const b = this.body;
    const n = this.body.kind.name;
    if (b.state === "dead") return n === "bomber" ? "explode" : n === "warrior" ? "dead" : "death";
    if (b.state === "hurt") return "hit";
    if (b.state === "spawn") return "spawn";
    const moving = Math.abs(b.vx) > 10 ? "run" : "idle";
    switch (this.body.kind.behavior) {
      case "melee":
        return b.state === "windup" || b.state === "attack" ? "strike" : moving;
      case "charger":
        return b.state === "charge" ? "charge" : moving;
      case "archer":
        return b.state === "windup" ? "shoot" : moving;
      case "bomber":
        return b.state === "windup" ? "electrocute" : moving;
    }
  }

  // Re-time a clip to its FSM state (authored ~10fps is choppy + longer than the
  // action). Shared by render + applyNet so host and guest play identically.
  private clipMs(suffix: string): number | undefined {
    const k = this.body.kind;
    switch (suffix) {
      case "run":
        return 460;
      case "strike":
        return ((k.windup ?? 0.3) + (k.active ?? 0.12)) * 1000;
      case "charge":
        return (k.chargeTime ?? 0.45) * 1000;
      case "shoot":
      case "electrocute":
        return (k.windup ?? 0.45) * 1000;
      case "hit":
        return 200;
      case "spawn":
        return 400;
      default:
        return undefined; // idle / death keep authored timing
    }
  }

  private playSuffix(key: string, suffix: string) {
    if (this.sprite.anims.currentAnim?.key === key) return; // already looping this clip
    const ms = this.clipMs(suffix);
    const cfg: Phaser.Types.Animations.PlayAnimationConfig = { key };
    if (ms !== undefined) cfg.duration = ms;
    this.sprite.play(cfg, true);
  }

  render() {
    const b = this.body;
    const suffix = this.clip();
    this.playSuffix(`${b.kind.name}:${suffix}`, suffix);
    this.sprite.setFlipX(b.facing < 0);
    this.sprite.setPosition(Math.round(b.x), Math.round(b.y));
    const flash = b.hitFlash > 0;
    if (flash && !this.flashing) {
      this.sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
      this.flashing = true;
    } else if (!flash && this.flashing) {
      this.sprite.clearTint().setTintMode(Phaser.TintModes.MULTIPLY);
      this.flashing = false;
    }
  }

  // Guest: replay the host's clip on this puppet (no local sim/state). Position
  // lerps toward the authoritative point so 30Hz snapshots render smoothly.
  applyNet(clip: string, x: number, y: number, flip: boolean, flash: boolean) {
    this.playSuffix(clip, clip.slice(clip.indexOf(":") + 1));
    this.sprite.setFlipX(flip);
    const far = Math.hypot(x - this.sprite.x, y - this.sprite.y) > 48;
    this.sprite.setPosition(
      far ? x : this.sprite.x + (x - this.sprite.x) * 0.35,
      far ? y : this.sprite.y + (y - this.sprite.y) * 0.35,
    );
    if (flash && !this.flashing) {
      this.sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
      this.flashing = true;
    } else if (!flash && this.flashing) {
      this.sprite.clearTint().setTintMode(Phaser.TintModes.MULTIPLY);
      this.flashing = false;
    }
  }

  destroy() {
    this.sprite.destroy();
  }
}
