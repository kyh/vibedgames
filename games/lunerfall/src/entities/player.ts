import type Phaser from "phaser";

import { HERO_ORIGIN_Y, HERO_SCALE, interp } from "../config";
import { kitClipKey } from "../data/clip-timing";
import type { HeroName } from "../data/animations";
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
// greyed-out crumple while in co-op last stand
const DOWNED_TINT = 0x7a_84_94;

// A clip's gameplay-matched playback duration (ms), or undefined to keep the
// authored timing. Swings/special/dash are re-timed to their mechanic; run is
// nudged snappier. Shared with the ?viewer page so it previews true in-game
// playback.
export const clipGameMs = (hero: HeroDef, clip: string): number | undefined => {
  const { kit } = hero;
  const sw = kit.swings.find((s) => s.clip === clip);
  if (sw) {
    return sw.dur * 1000;
  }
  if (clip === kit.special.clip) {
    const sp = kit.special;
    return ("dur" in sp ? sp.dur : 0.3) * 1000;
  }
  if (clip === kit.dashClip) {
    return DASH_DUR * 1000;
  }
  if (clip === "run") {
    return RUN_MS;
  }
  return undefined;
};

// i-frame flicker: alternate frames at 10 Hz while invulnerable.
const iframeAlpha = (iframes: number, dead: boolean): number => {
  if (iframes <= 0 || dead) {
    return 1;
  }
  return Math.floor(iframes * 20) % 2 === 0 ? 0.45 : 1;
};

// The subset of body/net fields selectClip reads — both PlayerBody and NetPlayer
// expose these names, so one method drives local render and remote puppets.
interface ClipState {
  dead: boolean;
  downed: boolean;
  specialActive: boolean;
  specialId: number;
  attackStep: number;
  swingId: number;
  hurting: boolean;
  dashing: boolean;
  grounded: boolean;
  vx: number;
  vy: number;
}

export interface PlayerHooks {
  onJump?: () => void;
  onWallJump?: (side: number) => void;
  onLand?: (impact: number) => void;
  onDash?: () => void;
  onSwing?: (step: number) => void;
  onSpecial?: (kind: string) => void;
  onHurt?: () => void;
}

// Phaser view over PlayerBody: owns the sprite, plays the hero's kit animations,
// and turns physics events into juice.
export class Player {
  readonly body: PlayerBody;
  readonly sprite: Phaser.GameObjects.Sprite;
  private baseScale = HERO_SCALE;
  readonly name: HeroName;
  private lastSwing = -1;
  private lastSpecial = -1;
  private lastRunDust = 0;
  private lastEcho = -Infinity;
  private swingClip: string | null = null;
  private scene: Phaser.Scene;
  private hero: HeroDef;

  constructor(
    scene: Phaser.Scene,
    grid: Grid,
    x: number,
    y: number,
    hero: HeroDef,
    hooks: PlayerHooks = {},
  ) {
    this.scene = scene;
    this.hero = hero;
    this.name = hero.name;
    this.sprite = scene.add.sprite(x, y, this.name);
    this.sprite.setOrigin(0.5, HERO_ORIGIN_Y).setScale(this.baseScale);
    this.sprite.play(`${this.name}:idle`);

    this.body = new PlayerBody(grid, x, y, hero.kit, {
      onDash: hooks.onDash,
      onHurt: hooks.onHurt,
      onJump: hooks.onJump,
      onLand: hooks.onLand,
      onSpecial: hooks.onSpecial,
      onSquash: (sx, sy, ms) => this.squash(sx, sy, ms),
      onSwing: hooks.onSwing,
      onWallJump: hooks.onWallJump,
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
  get title(): string {
    return this.hero.title;
  }
  get special(): string {
    return this.hero.kit.special.kind;
  }

  enterRoom(grid: Grid, x: number, y: number) {
    this.lastEcho = -Infinity;
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
      duration: ms,
      ease: "Back.easeOut",
      scaleX: this.baseScale,
      scaleY: this.baseScale,
      targets: this.sprite,
    });
    // landing squash kicks up dust
    if (sy < 1) {
      landPuff(this.scene, this.sprite.x, this.body.y);
    }
  }

  // Play a clip — the retimed @kit variant when one exists (attack clips whose
  // contact frame is aligned to the hitbox window; see data/clip-timing.ts),
  // else the base authored clip scaled to its gameplay ms via timeScale. NOTE:
  // passing `duration` to play() FREEZES Phaser anims that carry per-frame
  // durations (as ours do from Aseprite) — it renders frame 1 only; timeScale
  // re-times without that bug. @kit variants total their gameplay dur already,
  // so their ratio lands at ~1.
  private playClip(clip: string, loop: boolean) {
    this.sprite.play(this.clipKey(clip), loop);
    const ms = clipGameMs(this.hero, clip);
    const authored = this.sprite.anims.currentAnim?.duration ?? 0;
    this.sprite.anims.timeScale = ms !== undefined && ms > 0 && authored > 0 ? authored / ms : 1;
  }

  // The anim key a clip resolves to for this hero (kit variant preferred).
  private clipKey(clip: string): string {
    return kitClipKey(this.scene, this.hero.name, clip);
  }

  // Choose + play the clip for the current sim/net state. Shared by render (local
  // body) and applyNet (remote puppet) — both expose the same field names.
  private selectClip(s: ClipState) {
    if (s.dead || s.downed) {
      // Versus: a slain duelist crumples and holds the final death frame until
      // the round reset clears the flag. (Co-op deaths never set body.dead.)
      // Last stand: play the death clip once and hold its final crumpled frame.
      if (this.sprite.anims.currentAnim?.key !== `${this.name}:death`) {
        this.playClip("death", false);
      }
      this.swingClip = null;
      return;
    }
    if (s.specialActive || s.attackStep > 0) {
      this.selectActionClip(s);
      return;
    }
    this.lastSwing = -1;
    this.lastSpecial = -1;
    if (this.swingRecovering(s)) {
      return;
    }
    this.swingClip = null;
    this.playClip(this.locomotionClip(s), true);
  }

  private selectActionClip(s: ClipState) {
    const { kit } = this.hero;
    if (s.specialActive) {
      if (s.specialId !== this.lastSpecial) {
        this.playClip(kit.special.clip, false);
        this.lastSpecial = s.specialId;
      }
      this.swingClip = null;
      return;
    }
    const clip = kit.swings[s.attackStep - 1]?.clip ?? "idle";
    if (s.swingId !== this.lastSwing) {
      this.playClip(clip, false);
      this.lastSwing = s.swingId;
      this.swingClip = clip;
    }
  }

  // Hitbox window (attackStep) is shorter than the swing anim; while standing
  // still, let the swing play its recovery frames out instead of snapping to
  // idle mid-strike. Any movement / hit / dash cancels it (reads as responsive).
  private swingRecovering(s: ClipState): boolean {
    return (
      this.swingClip !== null &&
      this.sprite.anims.isPlaying &&
      this.sprite.anims.currentAnim?.key === this.clipKey(this.swingClip) &&
      !s.hurting &&
      !s.dashing &&
      s.grounded &&
      Math.abs(s.vx) < 20 &&
      s.vy > -20
    );
  }

  private locomotionClip(s: ClipState): string {
    if (s.hurting) {
      return "hurt";
    }
    if (s.dashing) {
      return this.hero.kit.dashClip;
    }
    if (s.grounded) {
      return Math.abs(s.vx) > 12 ? "run" : "idle";
    }
    return s.vy < -10 ? "jump" : "fall";
  }

  render(alpha = 1) {
    const b = this.body;
    this.selectClip(b);
    this.sprite.setFlipX(b.facing < 0);
    this.sprite.setPosition(
      Math.round(interp(b.prevX, b.x, alpha)),
      Math.round(interp(b.prevY, b.y, alpha)),
    );
    this.dashTrail(b.dashing);
    if (b.downed) {
      this.sprite.setTint(DOWNED_TINT);
    } else {
      this.sprite.clearTint();
    }
    this.sprite.setAlpha(iframeAlpha(b.iframes, b.dead));
    this.runTrail(b);
  }

  // Same scene-clock cadence for local render and remote puppet frames.
  private dashTrail(dashing: boolean) {
    if (!dashing) {
      this.lastEcho = -Infinity;
      return;
    }
    const { now } = this.scene.time;
    if (now - this.lastEcho < 40) {
      return;
    }
    this.lastEcho = now;
    afterImage(this.scene, this.sprite, this.hero.color);
  }

  // Kick a smoke puff off the back foot while running on the ground.
  private runTrail(b: PlayerBody) {
    if (!b.grounded || b.dashing || b.hurting || Math.abs(b.vx) < 70) {
      return;
    }
    const { now } = this.scene.time;
    if (now - this.lastRunDust < 80) {
      return;
    }
    this.lastRunDust = now;
    smoke(
      this.scene,
      this.sprite.x - b.facing * 5,
      b.y - 1,
      -b.facing * (10 + Math.random() * 10),
      -6 - Math.random() * 5,
      8,
    );
  }

  destroy() {
    this.scene.tweens.killTweensOf(this.sprite);
    this.sprite.destroy();
  }

  // Host: read the body into a wire player.
  encode(id: string): NetPlayer {
    const b = this.body;
    return {
      attackStep: b.attackStep,
      dashing: b.dashing,
      dead: b.dead,
      downed: b.downed,
      facing: b.facing,
      grounded: b.grounded,
      hero: this.name,
      hurting: b.hurting,
      id,
      iframes: b.iframes,
      specialActive: b.specialActive,
      specialId: b.specialId,
      swingId: b.swingId,
      vx: b.vx,
      vy: b.vy,
      x: b.x,
      y: b.y,
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
    b.downed = net.downed;
    b.iframes = net.iframes;
    this.selectClip(net);
    this.sprite.setFlipX(net.facing < 0);
    const tx = Math.round(net.x);
    const ty = Math.round(net.y);
    const far = Math.hypot(tx - this.sprite.x, ty - this.sprite.y) > 40;
    this.sprite.setPosition(
      far ? tx : this.sprite.x + (tx - this.sprite.x) * 0.4,
      far ? ty : this.sprite.y + (ty - this.sprite.y) * 0.4,
    );
    this.dashTrail(net.dashing);
    if (net.downed) {
      this.sprite.setTint(DOWNED_TINT);
    } else {
      this.sprite.clearTint();
    }
    this.sprite.setAlpha(iframeAlpha(net.iframes, net.dead));
  }
}
