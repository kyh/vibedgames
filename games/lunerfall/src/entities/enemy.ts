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
    this.sprite = scene.add.sprite(x, y, `${kind.name}:spawn`);
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

  render() {
    const b = this.body;
    this.sprite.play(`${b.kind.name}:${this.clip()}`, true);
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

  destroy() {
    this.sprite.destroy();
  }
}
