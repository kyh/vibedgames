import type Phaser from "phaser";

import { HERO_ORIGIN_Y, HERO_SCALE, interp } from "../config";
import { kitClipKey } from "../data/clip-timing";
import type { HeroName } from "../data/animations";
import type { HeroDef } from "../data/heroes";
import type { PlayerPose } from "../net/snapshot";
import { afterImage, landPuff, smoke } from "../sys/fx";
import type { Grid } from "../sys/grid";
import type { InputState } from "../sys/input";
import { DASH_DUR, PlayerBody } from "./player-body";

const RUN_MS = 520;
const DOWNED_TINT = 0x7a_84_94;

export const clipGameMs = (hero: HeroDef, clip: string) => {
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

  return clip === "run" ? RUN_MS : null;
};

const iframeAlpha = (iframes: number, dead: boolean) => {
  if (iframes <= 0 || dead) {
    return 1;
  }

  return Math.floor(iframes * 20) % 2 === 0 ? 0.45 : 1;
};

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

export class Player {
  readonly body: PlayerBody;
  readonly sprite: Phaser.GameObjects.Sprite;
  private readonly baseScale = HERO_SCALE;
  readonly name: HeroName;
  private lastSwing = -1;
  private lastSpecial = -1;
  private lastRunDust = 0;
  private lastEcho = -Infinity;
  private swingClip: string | null = null;
  private readonly scene: Phaser.Scene;
  private readonly hero: HeroDef;
  private readonly hooks: PlayerHooks;

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
    this.hooks = hooks;
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
      onSquash: (sx, sy, ms) => {
        this.squash(sx, sy, ms);
      },
      onSwing: hooks.onSwing,
      onWallJump: hooks.onWallJump,
    });
  }

  get x() {
    return this.body.x;
  }
  get y() {
    return this.body.y;
  }
  get color() {
    return this.hero.color;
  }
  get title() {
    return this.hero.title;
  }
  get special() {
    return this.hero.kit.special.kind;
  }

  enterRoom(grid: Grid, x: number, y: number) {
    this.lastEcho = -Infinity;
    this.body.enterRoom(grid, x, y);
    this.sprite.setPosition(Math.round(x), Math.round(y));
  }

  /** A duel round reset: alive again at the spawn point. */
  respawn(grid: Grid, x: number, y: number) {
    this.lastEcho = -Infinity;
    this.body.respawn(grid, x, y);
    this.sprite.setPosition(Math.round(x), Math.round(y));
  }

  /** The hit juice, for a hit that landed outside this body's own step (a
   * guest learning of the host's hit, whose replay runs silently). */
  cueHurt() {
    this.hooks.onHurt?.();
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

    if (sy < 1) {
      landPuff(this.scene, this.sprite.x, this.body.y);
    }
  }

  private playClip(clip: string, loop: boolean) {
    this.sprite.play(this.clipKey(clip), loop);
    const ms = clipGameMs(this.hero, clip);
    const authored = this.sprite.anims.currentAnim?.duration ?? 0;
    this.sprite.anims.timeScale = ms !== null && ms > 0 && authored > 0 ? authored / ms : 1;
  }

  private clipKey(clip: string) {
    return kitClipKey(this.scene, this.hero.name, clip);
  }

  private selectClip(s: ClipState) {
    if (s.dead || s.downed) {
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

  private swingRecovering(s: ClipState) {
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

  private locomotionClip(s: ClipState) {
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

  render(alpha = 1, dx = 0, dy = 0) {
    const b = this.body;
    this.selectClip(b);
    this.sprite.setFlipX(b.facing < 0);
    this.sprite.setPosition(
      Math.round(interp(b.prevX, b.x, alpha) + dx),
      Math.round(interp(b.prevY, b.y, alpha) + dy),
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

  applyPose(p: PlayerPose) {
    const b = this.body;
    b.x = p.x;
    b.y = p.y;
    b.vx = p.vx;
    b.vy = p.vy;
    b.facing = p.facing;
    b.grounded = p.grounded;
    b.dead = p.dead;
    b.downed = p.downed;
    b.iframes = p.iframes;
    this.selectClip(p);
    this.sprite.setFlipX(p.facing < 0);
    this.sprite.setPosition(Math.round(p.x), Math.round(p.y));
    this.dashTrail(p.dashing);

    if (p.downed) {
      this.sprite.setTint(DOWNED_TINT);
    } else {
      this.sprite.clearTint();
    }

    this.sprite.setAlpha(iframeAlpha(p.iframes, p.dead));
  }
}
