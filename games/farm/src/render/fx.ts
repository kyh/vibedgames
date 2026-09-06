import Phaser from "phaser";
import { DEPTH } from "../config";
import { itemIcon, type Item } from "../data/items";
import { onSceneExit } from "./scene-lifetime";

type Matter = "dust" | "droplet" | "leaf" | "spark";
type BurstOptions = {
  colors: number[];
  count?: number;
  speed?: number;
  gravity?: number;
  size?: number;
  up?: boolean;
  life?: number;
  matter?: Matter;
};
type Particle = {
  image: Phaser.GameObjects.Rectangle;
  vx: number;
  vy: number;
  gravity: number;
  spin: number;
  age: number;
  life: number;
};
type Reward = {
  image: Phaser.GameObjects.Image;
  fromX: number;
  fromY: number;
  target: { x: number; y: number };
  age: number;
};
type FxCounts = {
  particles: number;
  rewards: number;
  particleCapacity: number;
  rewardCapacity: number;
};

const PARTICLE_CAP = 144;
const REWARD_CAP = 8;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
const pools = new WeakMap<Phaser.Scene, SceneFx>();

/** Scene-local matter and reward sprites. One delta update, no per-particle timers. */
class SceneFx {
  private readonly particles: Particle[];
  private readonly rewards: Reward[];
  private cursor = 0;
  private rewardCursor = 0;

  constructor(scene: Phaser.Scene) {
    this.particles = Array.from({ length: PARTICLE_CAP }, () => ({
      image: scene.add.rectangle(0, 0, 2, 2, 0xffffff).setDepth(DEPTH.particles).setVisible(false),
      vx: 0,
      vy: 0,
      gravity: 0,
      spin: 0,
      age: 0,
      life: 1,
    }));
    this.rewards = Array.from({ length: REWARD_CAP }, () => ({
      image: scene.add
        .image(0, 0, "obj-fish")
        .setDepth(DEPTH.particles + 5)
        .setVisible(false),
      fromX: 0,
      fromY: 0,
      target: { x: 0, y: 0 },
      age: 1,
    }));
    const update = (_time: number, delta: number): void => this.update(Math.min(delta, 50) / 1000);
    scene.events.on(Phaser.Scenes.Events.POST_UPDATE, update);
    onSceneExit(scene, () => {
      scene.events.off(Phaser.Scenes.Events.POST_UPDATE, update);
      pools.delete(scene);
      // Phaser's display list owns destruction. No references survive a restart.
    });
  }

  burst(x: number, y: number, opts: BurstOptions): void {
    if (opts.colors.length === 0) return;
    const count = Math.min(PARTICLE_CAP, REDUCED_MOTION.matches ? 3 : (opts.count ?? 8));
    const size = opts.size ?? 2;
    const matter = opts.matter ?? "dust";
    for (let i = 0; i < count; i++) {
      const p = this.particles[this.cursor];
      this.cursor = (this.cursor + 1) % PARTICLE_CAP;
      if (!p) continue;
      const color = opts.colors[Math.floor(Math.random() * opts.colors.length)] ?? 0xffffff;
      const ang = opts.up
        ? -Math.PI / 2 + (Math.random() - 0.5) * 1.6
        : Math.random() * Math.PI * 2;
      const speed = (opts.speed ?? 50) * (0.4 + Math.random() * 0.9);
      p.vx = Math.cos(ang) * speed;
      p.vy = Math.sin(ang) * speed - (opts.up ? 30 : 0);
      p.gravity = opts.gravity ?? 120;
      p.spin = matter === "leaf" ? 160 : matter === "dust" ? 75 : 0;
      p.age = 0;
      p.life = Math.max(0.001, (opts.life ?? 520) / 1000);
      const w = matter === "leaf" ? size * 1.7 : matter === "droplet" ? size * 0.65 : size;
      const h = matter === "spark" || matter === "droplet" ? size * 1.8 : size;
      p.image
        .setPosition(x, y)
        .setSize(w, h)
        .setDisplaySize(w, h)
        .setFillStyle(color)
        .setAlpha(1)
        .setAngle(matter === "spark" ? (ang * 180) / Math.PI + 90 : 0)
        .setVisible(true);
    }
  }

  reward(x: number, y: number, target: { x: number; y: number }, item: Item): void {
    const reward = this.rewards[this.rewardCursor];
    this.rewardCursor = (this.rewardCursor + 1) % REWARD_CAP;
    if (!reward) return;
    const icon = itemIcon(item);
    reward.fromX = x;
    reward.fromY = y;
    reward.target = target;
    reward.age = 0;
    reward.image
      .setTexture(icon.key, icon.frame)
      .setPosition(x, y)
      .setScale(1)
      .setAlpha(1)
      .setVisible(true);
  }

  private update(dt: number): void {
    for (const p of this.particles) {
      if (!p.image.visible) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.image.setVisible(false);
        continue;
      }
      p.vy += p.gravity * dt;
      p.image.x += p.vx * dt;
      p.image.y += p.vy * dt;
      p.image.angle += p.spin * dt;
      p.image.setAlpha(1 - p.age / p.life);
    }
    for (const r of this.rewards) {
      if (!r.image.visible) continue;
      r.age += dt / 0.55;
      if (r.age >= 1) {
        r.image.setVisible(false);
        continue;
      }
      const t = r.age;
      const ease = t * t * (3 - 2 * t);
      const reduced = REDUCED_MOTION.matches;
      r.image
        .setPosition(
          reduced ? r.fromX : Phaser.Math.Linear(r.fromX, r.target.x, ease),
          reduced
            ? r.fromY - 12
            : Phaser.Math.Linear(r.fromY, r.target.y - 14, ease) - Math.sin(t * Math.PI) * 24,
        )
        .setAlpha(Math.min(1, (1 - t) * 4))
        .setScale(reduced ? 1 : 1 + Math.sin(t * Math.PI) * 0.18);
    }
  }

  counts(): FxCounts {
    return {
      particles: this.particles.filter((p) => p.image.visible).length,
      rewards: this.rewards.filter((r) => r.image.visible).length,
      particleCapacity: PARTICLE_CAP,
      rewardCapacity: REWARD_CAP,
    };
  }
}

function poolFor(scene: Phaser.Scene): SceneFx {
  const existing = pools.get(scene);
  if (existing) return existing;
  const pool = new SceneFx(scene);
  pools.set(scene, pool);
  return pool;
}

/** Render-only payoff; callers award inventory before requesting it. */
export function rewardArc(
  scene: Phaser.Scene,
  x: number,
  y: number,
  target: { x: number; y: number },
  item: Item,
): void {
  poolFor(scene).reward(x, y, target, item);
}

/** Read-only pool counts for lifecycle/performance checks; never allocates a pool. */
export function fxCounts(scene: Phaser.Scene): ReturnType<SceneFx["counts"]> | null {
  return pools.get(scene)?.counts() ?? null;
}

/** `size` (world pixels) and `life` (ms) default to every gameplay pop; a caller
 *  raises them only for a glyph that has to carry a beat on its own. */
export function floatText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  color = "#fff6d5",
  size = 11,
  life = 900,
): void {
  const t = scene.add
    .text(x, y, text, {
      fontFamily: "ui-monospace, monospace",
      fontSize: `${size}px`,
      fontStyle: "bold",
      color,
      stroke: "#3a2a14",
      strokeThickness: Math.max(3, Math.round(size / 4)),
    })
    .setOrigin(0.5, 1)
    .setDepth(DEPTH.particles + 10);
  scene.tweens.add({
    targets: t,
    y: y - 22,
    alpha: { from: 1, to: 0 },
    duration: life,
    ease: "Cubic.easeOut",
    onComplete: () => t.destroy(),
  });
}

// burst of small colored squares (dust, leaves, sparks, droplets)
export function burst(scene: Phaser.Scene, x: number, y: number, opts: BurstOptions): void {
  poolFor(scene).burst(x, y, opts);
}

export function shake(scene: Phaser.Scene, intensity = 0.004, duration = 120): void {
  if (REDUCED_MOTION.matches) return;
  scene.cameras.main.shake(duration, intensity);
}

// a quick squash-stretch "pop" tween on a sprite
export function pop(
  scene: Phaser.Scene,
  obj: Phaser.GameObjects.Components.Transform & { scaleX: number; scaleY: number },
): void {
  if (REDUCED_MOTION.matches) return;
  const sx = obj.scaleX,
    sy = obj.scaleY;
  scene.tweens.add({
    targets: obj,
    scaleX: sx * 1.25,
    scaleY: sy * 0.8,
    duration: 90,
    yoyo: true,
    ease: "Quad.easeOut",
  });
}
