import Phaser from "phaser";

import { BASE_H, BASE_W, COLORS } from "../config";

// Lightweight VFX drawn from scene-owned, fixed-size pools (no per-hit
// allocations or tweens): a runtime radial-glow texture ("fx-glow") for
// additive neon bloom, plus dot/shard/ring shapes. The pool is created lazily on
// the first effect and ticks off the scene's UPDATE event, so it also serves
// scenes that never call into the game loop.
const pools = new WeakMap<Phaser.Scene, SceneFx>();
const PARTICLES = 192;
const ECHOES = 32;
const LABELS = 16;
const reducedMotion =
  typeof window === "undefined" ? null : window.matchMedia("(prefers-reduced-motion: reduce)");

type SpriteFx = {
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
};
type SpriteOpts = {
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
};

class SpritePool {
  private slots: SpriteFx[] = [];
  private next = 0;

  constructor(scene: Phaser.Scene, cap: number) {
    for (let i = 0; i < cap; i++) {
      this.slots.push({
        image: scene.add.image(0, 0, "fx-glow").setVisible(false).setActive(false),
        age: 0,
        life: 0,
        x: 0,
        y: 0,
        dx: 0,
        dy: 0,
        sx: 1,
        sy: 1,
        end: 1,
        alpha: 1,
        ease: 2,
      });
    }
  }

  spawn(x: number, y: number, life: number, opts: SpriteOpts): Phaser.GameObjects.Image {
    const slot = this.slots.find((s) => s.age >= s.life) ?? this.slots[this.next];
    if (!slot) throw new Error("FX pool has no slots");
    this.next = (this.next + 1) % this.slots.length;
    Object.assign(slot, {
      age: 0,
      life,
      x,
      y,
      dx: opts.dx ?? 0,
      dy: opts.dy ?? 0,
      sx: opts.sx ?? 1,
      sy: opts.sy ?? opts.sx ?? 1,
      end: opts.end ?? 1,
      alpha: opts.alpha ?? 1,
      ease: opts.ease ?? 2,
    });
    return slot.image
      .setTexture(opts.key ?? "fx-glow", opts.frame)
      .setOrigin(0.5)
      .setFlipX(false)
      .setFlipY(false)
      .setPosition(x, y)
      .setScale(slot.sx, slot.sy)
      .setRotation(opts.rotation ?? 0)
      .setTint(opts.color ?? 0xffffff)
      .setAlpha(slot.alpha)
      .setDepth(opts.depth ?? 60)
      .setBlendMode(opts.add ? Phaser.BlendModes.ADD : Phaser.BlendModes.NORMAL)
      .setVisible(true)
      .setActive(true);
  }

  update(ms: number) {
    for (const s of this.slots) {
      if (s.age >= s.life) continue;
      s.age += ms;
      if (s.age >= s.life) {
        s.image.setVisible(false).setActive(false);
        continue;
      }
      const t = s.age / s.life;
      const eased = 1 - Math.pow(1 - t, s.ease);
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

type LabelFx = { text: Phaser.GameObjects.Text; age: number; x: number; y: number };

class SceneFx {
  readonly particles: SpritePool;
  readonly echoes: SpritePool;
  private labels: LabelFx[] = [];
  private nextLabel = 0;

  constructor(scene: Phaser.Scene) {
    ensureGlow(scene);
    ensureParticleTextures(scene);
    this.particles = new SpritePool(scene, PARTICLES);
    this.echoes = new SpritePool(scene, ECHOES);
    for (let i = 0; i < LABELS; i++) {
      this.labels.push({
        text: scene.add
          .text(0, 0, "", { fontFamily: "monospace", fontSize: "9px" })
          .setOrigin(0.5, 1)
          .setDepth(70)
          .setVisible(false)
          .setActive(false),
        age: 600,
        x: 0,
        y: 0,
      });
    }
    scene.events.on(Phaser.Scenes.Events.UPDATE, this.update, this);
    // Phaser destroys the display list after SHUTDOWN; only the registry needs dropping.
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      scene.events.off(Phaser.Scenes.Events.UPDATE, this.update, this);
      pools.delete(scene);
    });
  }

  private update(_time: number, delta: number) {
    const ms = Math.max(0, delta);
    this.particles.update(ms);
    if (reducedMotion?.matches) this.echoes.clear();
    else this.echoes.update(ms);
    for (const s of this.labels) {
      if (s.age >= 600) continue;
      s.age += ms;
      if (s.age >= 600) {
        s.text.setVisible(false).setActive(false);
        continue;
      }
      const eased = 1 - Math.pow(1 - s.age / 600, 2);
      s.text.setPosition(s.x, s.y - eased * 12).setAlpha(1 - eased);
    }
  }

  label(x: number, y: number, text: string, color: string) {
    const s = this.labels.find((s) => s.age >= 600) ?? this.labels[this.nextLabel];
    if (!s) return;
    this.nextLabel = (this.nextLabel + 1) % LABELS;
    s.age = 0;
    s.x = x;
    s.y = y;
    s.text
      .setText(text)
      .setColor(color)
      .setPosition(x, y)
      .setAlpha(1)
      .setVisible(true)
      .setActive(true);
  }

  clear() {
    this.particles.clear();
    this.echoes.clear();
    for (const s of this.labels) {
      s.age = 600;
      s.text.setVisible(false).setActive(false);
    }
  }
}

function fx(scene: Phaser.Scene): SceneFx {
  let pool = pools.get(scene);
  if (!pool) {
    pool = new SceneFx(scene);
    pools.set(scene, pool);
  }
  return pool;
}

/** Room change: hide every in-flight effect so nothing lingers over the new room. */
export function clearFx(scene: Phaser.Scene): void {
  pools.get(scene)?.clear();
}

export function ensureGlow(scene: Phaser.Scene) {
  if (scene.textures.exists("fx-glow")) return;
  const R = 24;
  const g = scene.make.graphics({ x: 0, y: 0 });
  for (let i = R; i > 0; i--) {
    g.fillStyle(0xffffff, 0.05 * Math.min(1, (R - i) / (R * 0.34)));
    g.fillCircle(R, R, i);
  }
  g.generateTexture("fx-glow", R * 2, R * 2);
  g.destroy();
}

function ensureParticleTextures(scene: Phaser.Scene) {
  if (scene.textures.exists("fx-dot")) return;
  const g = scene.make.graphics({ x: 0, y: 0 });
  g.fillStyle(0xffffff).fillCircle(4, 4, 4).generateTexture("fx-dot", 8, 8);
  g.clear().fillStyle(0xffffff).fillRect(0, 0, 4, 2).generateTexture("fx-shard", 4, 2);
  g.clear().lineStyle(2, 0xffffff).strokeCircle(32, 32, 30).generateTexture("fx-ring", 64, 64);
  g.destroy();
}

function glow(
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number,
  scale: number,
  ms: number,
  depth = 60,
) {
  if (reducedMotion?.matches) return;
  fx(scene).particles.spawn(x, y, ms, { color, sx: scale, end: 1.6, depth, add: true });
}

export function hitSpark(
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number = COLORS.teal,
  n = 6,
) {
  glow(scene, x, y, color, 0.5, 150, 61);
  for (let i = 0; i < Math.min(n, 24); i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 12 + Math.random() * 26;
    fx(scene).particles.spawn(x, y, 160 + Math.random() * 150, {
      key: "fx-shard",
      color,
      sx: (2 + Math.random() * 3) / 4,
      sy: 1,
      dx: Math.cos(a) * sp,
      dy: Math.sin(a) * sp,
      rotation: a,
      add: true,
    });
  }
  fx(scene).particles.spawn(x, y, 100, {
    key: "fx-dot",
    sx: 0.65,
    end: 1.5,
    alpha: 0.85,
    depth: 62,
  });
}

export function impactRing(
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number = COLORS.teal,
  r = 20,
) {
  glow(scene, x, y, color, 0.7, 200, 62);
  fx(scene).particles.spawn(x, y, 300, {
    key: "fx-ring",
    color,
    sx: (r * 0.4) / 30,
    end: 2.6,
    alpha: 0.9,
    ease: 3,
    depth: 62,
    add: true,
  });
}

export function afterImage(
  scene: Phaser.Scene,
  spr: Phaser.GameObjects.Sprite,
  color: number = COLORS.teal,
) {
  if (reducedMotion?.matches) return;
  fx(scene)
    .echoes.spawn(spr.x, spr.y, 240, {
      key: spr.texture.key,
      frame: spr.frame.name,
      color,
      sx: spr.scaleX,
      sy: spr.scaleY,
      alpha: 0.32,
      depth: spr.depth - 1,
      add: true,
    })
    .setOrigin(spr.originX, spr.originY)
    .setFlipX(spr.flipX);
}

export function smoke(
  scene: Phaser.Scene,
  x: number,
  y: number,
  vx: number,
  vy: number,
  size = 10,
  color = 0x7c8aa0,
) {
  fx(scene).particles.spawn(x, y, 340 + Math.random() * 160, {
    color,
    sx: size / 48,
    dx: vx,
    dy: vy,
    end: 2.1,
    alpha: 0.42,
    depth: 18,
  });
}

export function wallSmoke(scene: Phaser.Scene, x: number, y: number, side: number) {
  for (let i = 0; i < 4; i++)
    smoke(
      scene,
      x,
      y - i * 4,
      -side * (14 + Math.random() * 14),
      -8 + Math.random() * 14 - i * 2,
      8 + Math.random() * 6,
    );
}

export function dust(scene: Phaser.Scene, x: number, y: number) {
  for (let i = -1; i <= 1; i += 2)
    fx(scene).particles.spawn(x, y, 220, {
      key: "fx-dot",
      color: 0x9aa6b2,
      sx: 0.5,
      alpha: 0.5,
      end: 0.4,
      dx: i * (6 + Math.random() * 6),
      dy: -2,
      depth: 20,
    });
}

export function landPuff(scene: Phaser.Scene, x: number, y: number) {
  for (let i = -1; i <= 1; i += 2)
    for (let k = 0; k < 3; k++) {
      fx(scene).particles.spawn(x, y, 240 + Math.random() * 120, {
        key: "fx-dot",
        color: 0xaeb8c4,
        sx: (1 + Math.random() * 2) / 4,
        alpha: 0.55,
        end: 0.3,
        dx: i * (8 + Math.random() * 12),
        dy: -Math.random() * 4,
        depth: 20,
      });
    }
}

/** A small hot core, angular fragments, then slower normal-blend dust. */
export function explosion(
  scene: Phaser.Scene,
  x: number,
  y: number,
  r: number,
  color: number = COLORS.magenta,
) {
  glow(scene, x, y, color, r / 26, 240, 62);
  fx(scene).particles.spawn(x, y, 100, {
    key: "fx-dot",
    sx: r * 0.065,
    end: 1.35,
    alpha: 0.85,
    depth: 63,
  });
  impactRing(scene, x, y, color, r);
  hitSpark(scene, x, y, color, 14);
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6;
    smoke(scene, x, y, Math.cos(a) * r * 0.65, Math.sin(a) * r * 0.35 - 8, r * 0.45, color);
  }
}

// Slow-drifting neon embers for room ambience. Returns the emitter to destroy on
// room change.
export function ambientEmbers(
  scene: Phaser.Scene,
  color: number = COLORS.teal,
  roomW = BASE_W,
  roomH = BASE_H,
): Phaser.GameObjects.Particles.ParticleEmitter {
  ensureGlow(scene);
  return scene.add
    .particles(0, 0, "fx-glow", {
      x: { min: 0, max: roomW },
      y: { min: roomH * 0.3, max: roomH },
      lifespan: 4200,
      speedY: { min: -10, max: -26 },
      speedX: { min: -8, max: 8 },
      scale: { start: 0.11, end: 0 },
      alpha: { start: 0.45, end: 0 },
      frequency: Math.max(80, 340 * (BASE_W / roomW)),
      quantity: 1,
      tint: color,
      reserve: 56,
      maxAliveParticles: 56,
      blendMode: Phaser.BlendModes.ADD,
    })
    .setDepth(3);
}

export function popText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  color = "#f4f7fb",
) {
  fx(scene).label(x, y, text, color);
}
