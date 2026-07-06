import Phaser from "phaser";

import { HERO_ORIGIN_Y, HERO_SCALE } from "../config";
import type { HeroDef } from "../data/heroes";
import type { Grid } from "../sys/grid";
import type { InputState } from "../sys/input";
import { PlayerBody } from "./player-body";

export type PlayerHooks = {
  onJump?: () => void;
  onLand?: (impact: number) => void;
  onDash?: () => void;
  onSwing?: (step: number) => void;
  onSpecial?: (kind: string) => void;
  onHurt?: () => void;
};

// Phaser view over PlayerBody: owns the sprite, plays the hero's kit animations,
// and turns physics events into juice.
export class Player {
  readonly body: PlayerBody;
  readonly sprite: Phaser.GameObjects.Sprite;
  private baseScale = HERO_SCALE;
  private name: string;
  private lastSwing = -1;
  private lastSpecial = -1;

  constructor(
    private scene: Phaser.Scene,
    grid: Grid,
    x: number,
    y: number,
    private hero: HeroDef,
    hooks: PlayerHooks = {},
  ) {
    this.name = hero.name;
    this.sprite = scene.add.sprite(x, y, this.name);
    this.sprite.setOrigin(0.5, HERO_ORIGIN_Y).setScale(this.baseScale);
    this.sprite.play(`${this.name}:idle`);

    this.body = new PlayerBody(grid, x, y, hero.kit, {
      onJump: hooks.onJump,
      onLand: hooks.onLand,
      onDash: hooks.onDash,
      onSwing: hooks.onSwing,
      onSpecial: hooks.onSpecial,
      onHurt: hooks.onHurt,
      onSquash: (sx, sy, ms) => this.squash(sx, sy, ms),
    });
  }

  get x(): number {
    return this.body.x;
  }
  get y(): number {
    return this.body.y;
  }

  enterRoom(grid: Grid, x: number, y: number) {
    this.body.enterRoom(grid, x, y);
    this.sprite.setPosition(Math.round(x), Math.round(y));
  }

  buffer(input: InputState) {
    this.body.buffer(input);
  }

  step(dt: number) {
    this.body.step(dt);
  }

  private squash(sx: number, sy: number, ms: number) {
    this.scene.tweens.killTweensOf(this.sprite);
    this.sprite.setScale(this.baseScale * sx, this.baseScale * sy);
    this.scene.tweens.add({ targets: this.sprite, scaleX: this.baseScale, scaleY: this.baseScale, duration: ms, ease: "Back.easeOut" });
  }

  render() {
    const b = this.body;
    const kit = this.hero.kit;
    if (b.specialActive) {
      if (b.specialId !== this.lastSpecial) {
        this.sprite.play(`${this.name}:${kit.special.clip}`);
        this.lastSpecial = b.specialId;
      }
    } else if (b.attackStep > 0) {
      const clip = kit.swings[b.attackStep - 1]?.clip ?? "idle";
      if (b.swingId !== this.lastSwing) {
        this.sprite.play(`${this.name}:${clip}`);
        this.lastSwing = b.swingId;
      }
    } else {
      this.lastSwing = -1;
      this.lastSpecial = -1;
      let clip: string;
      if (b.hurting) clip = "hurt";
      else if (b.dashing) clip = kit.dashClip;
      else if (!b.grounded) clip = b.vy < -10 ? "jump" : "fall";
      else clip = Math.abs(b.vx) > 12 ? "run" : "idle";
      this.sprite.play(`${this.name}:${clip}`, true);
    }
    this.sprite.setFlipX(b.facing < 0);
    this.sprite.setPosition(Math.round(b.x), Math.round(b.y));
    this.sprite.setAlpha(b.iframes > 0 && !b.dead ? (Math.floor(b.iframes * 20) % 2 === 0 ? 0.45 : 1) : 1);
  }
}
