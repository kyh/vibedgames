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
// Wind-up flare: the boss's own colour pushed toward hot amber, so a telegraph
// BRIGHTENS the Lord instead of repainting it (see applyTint).
const FLARE = 0xff_b0_60;
const FLARE_MIX = 0.42;
// Seconds of charge between ghosts (= every 3rd step at the 60Hz fixed sim).
const GHOST_EVERY = 3 / 60;

// Per-channel lerp between two 0xRRGGBB colours. Channels are isolated by
// integer division rather than shifts; on 24-bit colours the results match.
const channel = (colour: number, base: number): number => Math.floor(colour / base) % 0x1_00;
const mixChannel = (a: number, b: number, t: number, base: number): number =>
  Math.round(channel(a, base) + (channel(b, base) - channel(a, base)) * t) * base;
const mixColor = (a: number, b: number, t: number): number =>
  mixChannel(a, b, t, 0x1_00_00) + mixChannel(a, b, t, 0x1_00) + mixChannel(a, b, t, 1);

// The clip for an FSM state — from the sim on the host, from the wire pose on
// a guest.
const bossClip = (state: BossState, moving: boolean): string => {
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
    default: {
      return moving ? "run" : "idle";
    }
  }
};

// Phaser view over BossBody: bigger salamander sprite recoloured per biome,
// state-driven clips, a bright flare on wind-ups, and a white hit-flash.
export class Boss {
  readonly body: BossBody;
  readonly sprite: Phaser.GameObjects.Sprite;
  // per-biome recolour, applied when idle
  private readonly baseTint: number;
  // wind-up tint, derived from baseTint
  private readonly flareTint: number;
  // charge ghost-trail emit clock (sim seconds, not frames)
  private trailT = 0;
  // previous stateT, to measure how far the SIM advanced
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

  // White fill on hit, a brightened flare of the boss's OWN colour on wind-up,
  // else the flat biome recolour. The wind-up used to be a flat orange repaint,
  // which cost every Lord its identity for the length of its telegraph — an ice
  // boss read as the fire boss exactly while its name was on screen.
  private applyTint(flash: boolean, telegraph: boolean) {
    if (flash) {
      this.sprite.setTint(0xff_ff_ff).setTintMode(TintModes.FILL);
    } else if (telegraph) {
      this.sprite.setTint(this.flareTint).setTintMode(TintModes.MULTIPLY);
    } else {
      this.sprite.setTint(this.baseTint).setTintMode(TintModes.MULTIPLY);
    }
  }

  action(): BossAction {
    return { elapsed: this.body.stateT, state: this.body.state };
  }

  private applyAction(action: BossAction): boolean {
    const pose = this.acting.pose(action);
    if (!pose) {
      return false;
    }
    showActorPose(this.sprite, "salamander", pose);
    this.posed = true;
    return true;
  }

  private playLoop(key: string): void {
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
    // A 300px/s body-check reused the plain run clip, so the arena charge read
    // as walking. Borrow the player's dash vocabulary: a ghost trail behind the
    // lunge (throttled — the sprite is 2.1x, a per-frame ghost is a smear).
    //
    // Throttled on SIM time, not rendered frames: render() runs once per display
    // refresh and keeps running while the sim is frozen, so a frame counter gave
    // a 120Hz screen twice the ghosts and stacked them on one pixel through every
    // hit-stop. stateT only advances when BossBody.step does.
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

  // Guest: draw this puppet at a pose interpolated from the host's snapshots
  // (no local sim), playing the pose the host's FSM state implies.
  applyPose(p: BossPose) {
    // the body mirrors the pose, for a guest judging stomps on its hurt box
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
