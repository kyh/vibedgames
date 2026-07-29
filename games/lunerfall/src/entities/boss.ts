import Phaser from "phaser";

import { HERO_ORIGIN_Y, interp } from "../config";
import { bossKind } from "../data/bosses";
import { afterImage } from "../sys/fx";
import type { Grid } from "../sys/grid";
import { BossBody } from "./boss-body";

const SCALE = 2.1;
// Wind-up flare: the boss's own colour pushed toward hot amber, so a telegraph
// BRIGHTENS the Lord instead of repainting it (see applyTint).
const FLARE = 0xffb060;
const FLARE_MIX = 0.42;
// Seconds of charge between ghosts (= every 3rd step at the 60Hz fixed sim).
const GHOST_EVERY = 3 / 60;

// Per-channel lerp between two 0xRRGGBB colours.
function mixColor(a: number, b: number, t: number): number {
  const ch = (shift: number): number => {
    const av = (a >> shift) & 0xff;
    const bv = (b >> shift) & 0xff;
    return Math.round(av + (bv - av) * t) << shift;
  };
  return ch(16) | ch(8) | ch(0);
}

// Phaser view over BossBody: bigger salamander sprite recoloured per biome,
// state-driven clips, a bright flare on wind-ups, and a white hit-flash.
export class Boss {
  readonly body: BossBody;
  readonly sprite: Phaser.GameObjects.Sprite;
  private readonly baseTint: number; // per-biome recolour, applied when idle
  private readonly flareTint: number; // wind-up tint, derived from baseTint
  private trailT = 0; // charge ghost-trail emit clock (sim seconds, not frames)
  private lastStateT = 0; // previous stateT, to measure how far the SIM advanced

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

  // White fill on hit, a brightened flare of the boss's OWN colour on wind-up,
  // else the flat biome recolour. The wind-up used to be a flat orange repaint,
  // which cost every Lord its identity for the length of its telegraph — an ice
  // boss read as the fire boss exactly while its name was on screen.
  private applyTint(flash: boolean, telegraph: boolean) {
    if (flash) this.sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    else if (telegraph) this.sprite.setTint(this.flareTint).setTintMode(Phaser.TintModes.MULTIPLY);
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
    } else this.trailT = 0;
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
