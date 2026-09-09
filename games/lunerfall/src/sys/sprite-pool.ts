import type Phaser from "phaser";
import { BlendModes } from "phaser";

// Fixed-size pool of pooled images driven by a hand-rolled ease (no per-hit
// allocations or tweens). Owned by SceneFx; see fx.ts for the effect recipes.
interface SpriteFx {
  image: Phaser.GameObjects.Image;
  age: number;
  life: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  end: number;
  alpha: number;
  ease: number;
}
export interface SpriteOpts {
  key?: string;
  frame?: string | number;
  color?: number;
  alpha?: number;
  dx?: number;
  dy?: number;
  sx?: number;
  sy?: number;
  end?: number;
  ease?: number;
  rotation?: number;
  depth?: number;
  add?: boolean;
}

export class SpritePool {
  private slots: SpriteFx[] = [];
  private next = 0;

  constructor(scene: Phaser.Scene, cap: number) {
    for (let i = 0; i < cap; i += 1) {
      this.slots.push({
        age: 0,
        alpha: 1,
        dx: 0,
        dy: 0,
        ease: 2,
        end: 1,
        image: scene.add.image(0, 0, "fx-glow").setVisible(false).setActive(false),
        life: 0,
        sx: 1,
        sy: 1,
        x: 0,
        y: 0,
      });
    }
  }

  spawn(x: number, y: number, life: number, opts: SpriteOpts): Phaser.GameObjects.Image {
    const slot = this.slots.find((s) => s.age >= s.life) ?? this.slots[this.next];
    if (!slot) {
      throw new Error("FX pool has no slots");
    }
    this.next = (this.next + 1) % this.slots.length;
    Object.assign(slot, {
      age: 0,
      alpha: opts.alpha ?? 1,
      dx: opts.dx ?? 0,
      dy: opts.dy ?? 0,
      ease: opts.ease ?? 2,
      end: opts.end ?? 1,
      life,
      sx: opts.sx ?? 1,
      sy: opts.sy ?? opts.sx ?? 1,
      x,
      y,
    });
    return slot.image
      .setTexture(opts.key ?? "fx-glow", opts.frame)
      .setOrigin(0.5)
      .setFlipX(false)
      .setFlipY(false)
      .setPosition(x, y)
      .setScale(slot.sx, slot.sy)
      .setRotation(opts.rotation ?? 0)
      .setTint(opts.color ?? 0xff_ff_ff)
      .setAlpha(slot.alpha)
      .setDepth(opts.depth ?? 60)
      .setBlendMode(opts.add ? BlendModes.ADD : BlendModes.NORMAL)
      .setVisible(true)
      .setActive(true);
  }

  update(ms: number) {
    for (const s of this.slots) {
      if (s.age >= s.life) {
        continue;
      }
      s.age += ms;
      if (s.age >= s.life) {
        s.image.setVisible(false).setActive(false);
        continue;
      }
      const t = s.age / s.life;
      const eased = 1 - (1 - t) ** s.ease;
      const scale = 1 + (s.end - 1) * eased;
      s.image
        .setPosition(s.x + s.dx * eased, s.y + s.dy * eased)
        .setScale(s.sx * scale, s.sy * scale)
        .setAlpha(s.alpha * (1 - eased));
    }
  }

  clear() {
    for (const s of this.slots) {
      s.age = s.life;
      s.image.setVisible(false).setActive(false);
    }
    this.next = 0;
  }
}
