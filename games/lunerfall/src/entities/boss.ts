import type Phaser from "phaser";
import { TintModes } from "phaser";

import { HERO_ORIGIN_Y, interp } from "../config";
import { showActorPose } from "../data/actor-animation";
import { BossActing } from "../data/actor-presentation";
import type { BossAction } from "../data/actor-presentation";
import { bossKind } from "../data/bosses";
import type { BossPose } from "../net/snapshot";
import { afterImage } from "../sys/fx";
import type { Grid } from "../sys/grid";
import { BossBody } from "./boss-body";
import type { BossState } from "./boss-body";

const SCALE = 2.1;
const FLARE = 0xff_b0_60;
const FLARE_MIX = 0.42;
const GHOST_EVERY = 3 / 60;

const channel = (colour: number, base: number) => Math.floor(colour / base) % 0x1_00;

const mixChannel = (a: number, b: number, t: number, base: number) =>
  Math.round(channel(a, base) + (channel(b, base) - channel(a, base)) * t) * base;

const mixColor = (a: number, b: number, t: number) =>
  mixChannel(a, b, t, 0x1_00_00) + mixChannel(a, b, t, 0x1_00) + mixChannel(a, b, t, 1);

const bossClip = (state: BossState, moving: boolean) => {
  switch (state) {
    case "dead": {
      return "death";
    }

    case "wave": {
      return "flame-wave";
    }

    case "jump":
    case "slam": {
      return "flame-slam";
    }

    case "charge": {
      return "run";
    }

    case "punch": {
      return "fire-punch";
    }

    case "hurt": {
      return "hit";
    }

    case "idle":
    case "intro":
    case "phase": {
      return moving ? "run" : "idle";
    }

    default: {
      const unhandled: never = state;
      throw new Error("unhandled case", { cause: unhandled });
    }
  }
};

export class Boss {
  readonly body: BossBody;
  readonly sprite: Phaser.GameObjects.Sprite;
  private readonly baseTint: number;
  private readonly flareTint: number;
  private trailT = 0;
  private lastStateT = 0;
  private readonly acting = new BossActing();
  private posed = false;

  constructor(scene: Phaser.Scene, grid: Grid, x: number, y: number, biome: number) {
    this.body = new BossBody(grid, x, y, biome);
    this.baseTint = bossKind(biome).tint;
    this.flareTint = mixColor(this.baseTint, FLARE, FLARE_MIX);
    this.sprite = scene.add
      .sprite(x, y, "salamander")
      .setOrigin(0.5, HERO_ORIGIN_Y)
      .setScale(SCALE)
      .setDepth(12)
      .setTint(this.baseTint);
    this.sprite.play("salamander:idle");
  }

  private applyTint(flash: boolean, telegraph: boolean) {
    if (flash) {
      this.sprite.setTint(0xff_ff_ff).setTintMode(TintModes.FILL);
    } else if (telegraph) {
      this.sprite.setTint(this.flareTint).setTintMode(TintModes.MULTIPLY);
    } else {
      this.sprite.setTint(this.baseTint).setTintMode(TintModes.MULTIPLY);
    }
  }

  action() {
    return { elapsed: this.body.stateT, state: this.body.state };
  }

  private applyAction(action: BossAction) {
    const pose = this.acting.pose(action);

    if (!pose) {
      return false;
    }

    showActorPose(this.sprite, "salamander", pose);
    this.posed = true;

    return true;
  }

  private playLoop(key: string) {
    if (this.posed) {
      this.sprite.anims.resume();
      this.posed = false;
    }

    if (this.sprite.anims.currentAnim?.key !== key) {
      this.sprite.play(key, true);
    }
  }

  render(alpha = 1) {
    const b = this.body;

    if (!this.applyAction(this.action())) {
      this.playLoop(`salamander:${bossClip(b.state, Math.abs(b.vx) > 12)}`);
    }

    this.sprite.setFlipX(b.facing < 0);
    this.sprite.setPosition(
      Math.round(interp(b.prevX, b.x, alpha)),
      Math.round(interp(b.prevY, b.y, alpha)),
    );
    this.applyTint(b.hitFlash > 0, b.telegraphing);
    const simDt = Math.max(0, b.stateT - this.lastStateT);
    this.lastStateT = b.stateT;

    if (b.state === "charge" && Math.abs(b.vx) > 120) {
      this.trailT += simDt;

      if (this.trailT >= GHOST_EVERY) {
        this.trailT = 0;
        afterImage(this.sprite.scene, this.sprite, this.baseTint);
      }
    } else {
      this.trailT = 0;
    }
  }

  applyPose(p: BossPose) {
    this.body.x = p.x;
    this.body.y = p.y;

    if (!this.applyAction({ elapsed: p.elapsed, state: p.state })) {
      this.playLoop(`salamander:${bossClip(p.state, p.moving)}`);
    }

    this.sprite.setFlipX(p.flip);
    this.sprite.setPosition(Math.round(p.x), Math.round(p.y));
    this.applyTint(p.flash, p.telegraph);
  }

  destroy() {
    this.sprite.destroy();
  }
}
