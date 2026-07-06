import Phaser from "phaser";

import { HERO_ORIGIN_Y, HERO_SCALE } from "../config";
import type { HeroDef } from "../data/heroes";
import type { NetPlayer } from "../net/snapshot";
import { afterImage, landPuff, smoke } from "../sys/fx";
import type { Grid } from "../sys/grid";
import type { InputState } from "../sys/input";
import { DASH_DUR, PlayerBody } from "./player-body";

// The Aseprite sources are authored at a flat ~10fps, which is both choppy and
// far longer than the gameplay actions (a 0.22s swing shipped a 1.0s clip, so
// only the first frames ever showed). Action clips are re-timed to their exact
// gameplay duration; run is nudged snappier than the authored 10fps.
const RUN_MS = 520;

// A clip's gameplay-matched playback duration (ms), or undefined to keep the
// authored timing. Swings/special/dash are re-timed to their mechanic; run is
// nudged snappier. Shared with the ?editor gallery so it previews true in-game
// playback.
export function clipGameMs(hero: HeroDef, clip: string): number | undefined {
  const kit = hero.kit;
  const sw = kit.swings.find((s) => s.clip === clip);
  if (sw) return sw.dur * 1000;
  if (clip === kit.special.clip) {
    const sp = kit.special;
    return ("dur" in sp ? sp.dur : 0.3) * 1000;
  }
  if (clip === kit.dashClip) return DASH_DUR * 1000;
  if (clip === "run") return RUN_MS;
  return undefined;
}

export type PlayerHooks = {
  onJump?: () => void;
  onWallJump?: (side: number) => void;
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
  private lastRunDust = 0;

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
      onWallJump: hooks.onWallJump,
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
  get color(): number {
    return this.hero.color;
  }
  get special(): string {
    return this.hero.kit.special.kind;
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
    this.scene.tweens.add({
      targets: this.sprite,
      scaleX: this.baseScale,
      scaleY: this.baseScale,
      duration: ms,
      ease: "Back.easeOut",
    });
    if (sy < 1) landPuff(this.scene, this.sprite.x, this.body.y); // landing squash kicks up dust
  }

  // Play a clip, re-timed to gameplay via timeScale. NOTE: passing `duration` to
  // play() FREEZES Phaser anims that carry per-frame durations (as ours do from
  // Aseprite) — it renders frame 1 only. timeScale speeds the same frames up
  // without that bug, so the full swing plays inside the mechanic's window.
  private playClip(clip: string, loop: boolean) {
    this.sprite.play(`${this.name}:${clip}`, loop);
    const ms = clipGameMs(this.hero, clip);
    const authored = this.sprite.anims.currentAnim?.duration ?? 0;
    this.sprite.anims.timeScale = ms !== undefined && ms > 0 && authored > 0 ? authored / ms : 1;
  }

  render() {
    const b = this.body;
    const kit = this.hero.kit;
    if (b.specialActive) {
      if (b.specialId !== this.lastSpecial) {
        this.playClip(kit.special.clip, false);
        this.lastSpecial = b.specialId;
      }
    } else if (b.attackStep > 0) {
      const clip = kit.swings[b.attackStep - 1]?.clip ?? "idle";
      if (b.swingId !== this.lastSwing) {
        this.playClip(clip, false);
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
      this.playClip(clip, true);
    }
    this.sprite.setFlipX(b.facing < 0);
    this.sprite.setPosition(Math.round(b.x), Math.round(b.y));
    if (b.dashing) afterImage(this.scene, this.sprite, this.hero.color);
    this.sprite.setAlpha(
      b.iframes > 0 && !b.dead ? (Math.floor(b.iframes * 20) % 2 === 0 ? 0.45 : 1) : 1,
    );
    this.runTrail(b);
  }

  // Kick a smoke puff off the back foot while running on the ground.
  private runTrail(b: PlayerBody) {
    if (!b.grounded || b.dashing || b.hurting || Math.abs(b.vx) < 70) return;
    const now = this.scene.time.now;
    if (now - this.lastRunDust < 80) return;
    this.lastRunDust = now;
    smoke(this.scene, this.sprite.x - b.facing * 5, b.y - 1, -b.facing * (10 + Math.random() * 10), -6 - Math.random() * 5, 8);
  }

  destroy() {
    this.scene.tweens.killTweensOf(this.sprite);
    this.sprite.destroy();
  }

  // Host: read the body into a wire player.
  encode(id: string): NetPlayer {
    const b = this.body;
    return {
      id,
      hero: this.name,
      x: b.x,
      y: b.y,
      facing: b.facing,
      vx: b.vx,
      vy: b.vy,
      grounded: b.grounded,
      dashing: b.dashing,
      hurting: b.hurting,
      dead: b.dead,
      iframes: b.iframes,
      attackStep: b.attackStep,
      swingId: b.swingId,
      specialActive: b.specialActive,
      specialId: b.specialId,
    };
  }

  // Guest: drive the view straight from a wire player (no local sim). Sprite
  // position lerps toward the authoritative point to smooth the ~20Hz feed.
  applyNet(net: NetPlayer) {
    const b = this.body;
    b.x = net.x;
    b.y = net.y;
    b.vx = net.vx;
    b.vy = net.vy;
    b.facing = net.facing < 0 ? -1 : 1;
    b.grounded = net.grounded;
    b.dead = net.dead;
    b.iframes = net.iframes;
    const kit = this.hero.kit;
    if (net.specialActive) {
      if (net.specialId !== this.lastSpecial) {
        this.playClip(kit.special.clip, false);
        this.lastSpecial = net.specialId;
      }
    } else if (net.attackStep > 0) {
      const clip = kit.swings[net.attackStep - 1]?.clip ?? "idle";
      if (net.swingId !== this.lastSwing) {
        this.playClip(clip, false);
        this.lastSwing = net.swingId;
      }
    } else {
      this.lastSwing = -1;
      this.lastSpecial = -1;
      let clip: string;
      if (net.hurting) clip = "hurt";
      else if (net.dashing) clip = kit.dashClip;
      else if (!net.grounded) clip = net.vy < -10 ? "jump" : "fall";
      else clip = Math.abs(net.vx) > 12 ? "run" : "idle";
      this.playClip(clip, true);
    }
    this.sprite.setFlipX(net.facing < 0);
    const tx = Math.round(net.x);
    const ty = Math.round(net.y);
    const far = Math.hypot(tx - this.sprite.x, ty - this.sprite.y) > 40;
    this.sprite.setPosition(
      far ? tx : this.sprite.x + (tx - this.sprite.x) * 0.4,
      far ? ty : this.sprite.y + (ty - this.sprite.y) * 0.4,
    );
    if (net.dashing) afterImage(this.scene, this.sprite, this.hero.color);
    this.sprite.setAlpha(
      net.iframes > 0 && !net.dead ? (Math.floor(net.iframes * 20) % 2 === 0 ? 0.45 : 1) : 1,
    );
  }
}
