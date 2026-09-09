import Phaser from "phaser";

import type { Vec } from "../shared/constants";
import { BattleFx, REDUCED_MOTION } from "./battle-fx";

export type FxImportance = "common" | "important";

/** Keep a quarter of a pool free for major beats: common traffic may replace
 * an older common effect, never a shield, progression or boss response. */
function admitFx<T extends { importance: FxImportance }>(
  entries: T[],
  capacity: number,
  importance: FxImportance,
): boolean {
  const limit = importance === "important" ? capacity : capacity - Math.ceil(capacity / 4);
  if (entries.length < limit) {
    return true;
  }
  const expendable = entries.findIndex((entry) => entry.importance === "common");
  if (expendable === -1) {
    return false;
  }
  entries.splice(expendable, 1);
  return true;
}

// Pooled VFX (vfx skill rules): the two particle emitters are created ONCE and
// fired with explode(); stroke-shatter groups, shockwave rings and converge
// motes are plain data drawn into two shared Graphics layers per frame.
// BattleFx owns the separately bounded weapon light and staged blast layers.

/** Hard cap on live particles across both emitters. */
const PARTICLE_BUDGET = 700;
/** Common bursts leave room for local shield damage and major rewards. */
const COMMON_PARTICLE_BUDGET = 600;
/** Trail emitters throttle ×2 above this (v2: earlier, for the bigger crowds). */
export const PARTICLE_SOFT_BUDGET = 480;
/** Skip non-kill hit-spark spawns above this (keep the white victim flash). */
export const HITSPARK_SKIP_BUDGET = 580;
/** Skip spawning effects further than this outside the camera rect. */
const OFFSCREEN_PAD = 100;
const MAX_SHATTER_GROUPS = 24;
/** NOVA pulses + mine blasts are ring-hungry; rings are pooled Graphics. */
const MAX_RINGS = 20;
const MAX_CONVERGES = 12;
const SHATTER_LIFE_MS = 500;

interface ShatterSeg {
  // segment half-vector (rotates), midpoint offset from origin (flies outward)
  hx: number;
  hy: number;
  mx: number;
  my: number;
  vx: number;
  vy: number;
  rotV: number; // rad/s
  rot: number;
}

interface ShatterGroup {
  importance: FxImportance;
  x: number;
  y: number;
  tint: number;
  bornAt: number;
  segs: ShatterSeg[];
}

interface Ring {
  importance: FxImportance;
  x: number;
  y: number;
  r0: number;
  r1: number;
  alpha0: number;
  tint: number;
  bornAt: number;
  durMs: number;
}

interface Converge {
  importance: FxImportance;
  x: number;
  y: number;
  count: number;
  radius: number;
  tint: number;
  bornAt: number;
  durMs: number;
  seed: number;
}

export interface SparkOpts {
  importance?: FxImportance;
  angleMin?: number; // degrees
  angleMax?: number;
  speedMin?: number;
  speedMax?: number;
  lifeMin?: number;
  lifeMax?: number;
  scale?: number;
}

interface HullCue {
  x: number;
  y: number;
  points: ReadonlyArray<Vec>;
  rot: number;
  bornAt: number;
}
interface BossCue {
  x: number;
  y: number;
  tint: number;
  bornAt: number;
}

export class FxPool {
  readonly battle: BattleFx;
  private scene: Phaser.Scene;
  private sparkAdd: Phaser.GameObjects.Particles.ParticleEmitter;
  private debrisNormal: Phaser.GameObjects.Particles.ParticleEmitter;
  private shatterGfx: Phaser.GameObjects.Graphics;
  private ringGfx: Phaser.GameObjects.Graphics;
  private shatters: ShatterGroup[] = [];
  private rings: Ring[] = [];
  private converges: Converge[] = [];
  private hullCue: HullCue | null = null;
  private bossCue: BossCue | null = null;
  private hullText: Phaser.GameObjects.Text;
  private bossText: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.battle = new BattleFx(scene);
    this.sparkAdd = scene.add.particles(0, 0, "spark", {
      alpha: { end: 0, start: 1 },
      angle: { max: 360, min: 0 },
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
      lifespan: { max: 300, min: 150 },
      scale: { end: 0, start: 0.6 },
      speed: { max: 140, min: 30 },
    });
    this.sparkAdd.setDepth(20);
    this.debrisNormal = scene.add.particles(0, 0, "star", {
      alpha: { end: 0, start: 1 },
      angle: { max: 360, min: 0 },
      blendMode: Phaser.BlendModes.NORMAL,
      emitting: false,
      lifespan: { max: 500, min: 300 },
      rotate: { max: 360, min: 0 },
      scale: { end: 0.2, start: 0.8 },
      speed: { max: 160, min: 60 },
    });
    this.debrisNormal.setDepth(14);
    this.shatterGfx = scene.add.graphics().setDepth(16);
    this.ringGfx = scene.add.graphics().setDepth(21).setBlendMode(Phaser.BlendModes.ADD);
    const textStyle = { color: "#dce9f0", fontFamily: "monospace", fontSize: "10px" };
    this.hullText = scene.add
      .text(0, 0, "", textStyle)
      .setOrigin(0.5)
      .setDepth(22)
      .setVisible(false);
    this.bossText = scene.add
      .text(0, 0, "DREADNOUGHT DOWN", textStyle)
      .setOrigin(0.5)
      .setDepth(22)
      .setVisible(false);
  }

  reset(): void {
    this.battle.reset();
    this.shatters.length = 0;
    this.rings.length = 0;
    this.converges.length = 0;
    this.hullCue = null;
    this.bossCue = null;
    this.sparkAdd.killAll();
    this.debrisNormal.killAll();
    this.shatterGfx.clear();
    this.ringGfx.clear();
    this.hullText.setVisible(false);
    this.bossText.setVisible(false);
  }

  aliveParticles(): number {
    return this.sparkAdd.getAliveParticleCount() + this.debrisNormal.getAliveParticleCount();
  }

  private onScreen(x: number, y: number): boolean {
    const v = this.scene.cameras.main.worldView;
    return (
      x >= v.x - OFFSCREEN_PAD &&
      x <= v.right + OFFSCREEN_PAD &&
      y >= v.y - OFFSCREEN_PAD &&
      y <= v.bottom + OFFSCREEN_PAD
    );
  }

  /** ADD energy sparks (the one spark texture, re-tinted/re-aimed per burst). */
  sparks(x: number, y: number, count: number, tint: number, opts: SparkOpts = {}): void {
    if (!this.onScreen(x, y)) {
      return;
    }
    const budget = opts.importance === "important" ? PARTICLE_BUDGET : COMMON_PARTICLE_BUDGET;
    const n = Math.min(count, Math.max(0, budget - this.aliveParticles()));
    if (n <= 0) {
      return;
    }
    const e = this.sparkAdd;
    // Per-burst min/max overrides must go through updateConfig (re-runs
    // loadConfig); the setEmitterAngle/setParticleLifespan/etc. mutators
    // silently no-op for min/max + eased ops in Phaser 4.
    e.updateConfig({
      angle: { max: opts.angleMax ?? 360, min: opts.angleMin ?? 0 },
      lifespan: { max: opts.lifeMax ?? 250, min: opts.lifeMin ?? 150 },
      scale: { end: 0, start: opts.scale ?? 0.6 },
      speed: { max: opts.speedMax ?? 350, min: opts.speedMin ?? 150 },
    });
    e.setParticleTint(tint);
    e.explode(n, x, y);
  }

  /** NORMAL matter debris (star texture). */
  debris(x: number, y: number, count: number, tint: number, opts: SparkOpts = {}): void {
    if (!this.onScreen(x, y)) {
      return;
    }
    const budget = opts.importance === "important" ? PARTICLE_BUDGET : COMMON_PARTICLE_BUDGET;
    const n = Math.min(count, Math.max(0, budget - this.aliveParticles()));
    if (n <= 0) {
      return;
    }
    const e = this.debrisNormal;
    e.updateConfig({
      angle: { max: opts.angleMax ?? 360, min: opts.angleMin ?? 0 },
      lifespan: { max: opts.lifeMax ?? 500, min: opts.lifeMin ?? 300 },
      speed: { max: opts.speedMax ?? 160, min: opts.speedMin ?? 60 },
    });
    e.setParticleTint(tint);
    e.explode(n, x, y);
  }

  /** Shockwave ring: r0→r1 over durMs, alpha0→0, Cubic.Out, ADD. */
  ring(
    x: number,
    y: number,
    r0: number,
    r1: number,
    durMs: number,
    tint: number,
    alpha0 = 0.8,
    importance: FxImportance = "common",
  ): void {
    if (!this.onScreen(x, y)) {
      return;
    }
    if (!admitFx(this.rings, MAX_RINGS, importance)) {
      return;
    }
    this.rings.push({ alpha0, bornAt: this.scene.time.now, durMs, importance, r0, r1, tint, x, y });
  }

  /**
   * Stroke-shatter: a closed polygon (points relative to origin, pre-rotated)
   * decomposes into its edge segments — each flies outward 80–200 px/s,
   * rotates ±3 rad/s, fades over 500ms. NORMAL blend, hull tint.
   */
  shatter(
    x: number,
    y: number,
    points: readonly Vec[],
    rot: number,
    tint: number,
    importance: FxImportance = "common",
  ): void {
    if (!this.onScreen(x, y) || points.length < 2) {
      return;
    }
    if (!admitFx(this.shatters, MAX_SHATTER_GROUPS, importance)) {
      return;
    }
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const segs: ShatterSeg[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (!a || !b) {
        continue;
      }
      // rotate into world orientation
      const ax = a.x * cos - a.y * sin;
      const ay = a.x * sin + a.y * cos;
      const bx = b.x * cos - b.y * sin;
      const by = b.x * sin + b.y * cos;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const outLen = Math.hypot(mx, my) || 1;
      const speed = 80 + Math.random() * 120;
      segs.push({
        hx: (bx - ax) / 2,
        hy: (by - ay) / 2,
        mx,
        my,
        rot: 0,
        rotV: (Math.random() * 2 - 1) * 3,
        vx: (mx / outLen) * speed,
        vy: (my / outLen) * speed,
      });
    }
    this.shatters.push({ bornAt: this.scene.time.now, importance, segs, tint, x, y });
  }

  /** Motes converging inward from radius→0 over durMs (anticipation). */
  converge(
    x: number,
    y: number,
    count: number,
    radius: number,
    durMs: number,
    tint: number,
    importance: FxImportance = "common",
  ): void {
    if (!this.onScreen(x, y)) {
      return;
    }
    if (!admitFx(this.converges, MAX_CONVERGES, importance)) {
      return;
    }
    this.converges.push({
      bornAt: this.scene.time.now,
      count,
      durMs,
      importance,
      radius,
      seed: Math.random() * Math.PI * 2,
      tint,
      x,
      y,
    });
  }

  /** One intact hull echo distinguishes growth from a kill's flying fragments. */
  hullUpgrade(x: number, y: number, points: readonly Vec[], rot: number, level: number): void {
    this.hullCue = { bornAt: this.scene.time.now, points, rot, x, y };
    this.hullText.setText(`HULL ${level} · UPGRADED`);
  }

  bossDefeat(x: number, y: number, tint: number): void {
    if (!this.onScreen(x, y)) {
      return;
    }
    this.bossCue = { bornAt: this.scene.time.now, tint, x, y };
  }

  /** Redraw all pooled stroke FX. Call once per frame. */
  update(dt: number, now: number): void {
    this.battle.update(now);
    const sg = this.shatterGfx;
    sg.clear();
    this.shatters = this.shatters.filter((g) => now - g.bornAt < SHATTER_LIFE_MS);
    for (const g of this.shatters) {
      const age = (now - g.bornAt) / SHATTER_LIFE_MS;
      const alpha = 1 - age;
      sg.lineStyle(1, g.tint, alpha);
      for (const s of g.segs) {
        s.mx += s.vx * dt;
        s.my += s.vy * dt;
        s.rot += s.rotV * dt;
        const cos = Math.cos(s.rot);
        const sin = Math.sin(s.rot);
        const hx = s.hx * cos - s.hy * sin;
        const hy = s.hx * sin + s.hy * cos;
        sg.lineBetween(g.x + s.mx - hx, g.y + s.my - hy, g.x + s.mx + hx, g.y + s.my + hy);
      }
    }

    const rg = this.ringGfx;
    rg.clear();
    this.rings = this.rings.filter((r) => now - r.bornAt < r.durMs);
    for (const r of this.rings) {
      const t = (now - r.bornAt) / r.durMs;
      const eased = 1 - (1 - t) ** 3; // Cubic.Out
      const radius = r.r0 + (r.r1 - r.r0) * eased;
      rg.lineStyle(1, r.tint, r.alpha0 * (1 - t));
      rg.strokeCircle(r.x, r.y, radius);
    }
    this.converges = this.converges.filter((c) => now - c.bornAt < c.durMs);
    for (const c of this.converges) {
      const t = (now - c.bornAt) / c.durMs;
      const dist = c.radius * (1 - t);
      rg.fillStyle(c.tint, 0.9 * (1 - t * 0.4));
      for (let i = 0; i < c.count; i++) {
        const ang = c.seed + (Math.PI * 2 * i) / c.count;
        rg.fillCircle(c.x + Math.cos(ang) * dist, c.y + Math.sin(ang) * dist, 1.5);
      }
    }
    this.drawMilestones(now);
  }

  private drawMilestones(now: number): void {
    const sw = 1 / Math.max(0.35, this.scene.cameras.main.zoom);
    const hull = this.hullCue;
    if (hull) {
      const t = Math.min(1, (now - hull.bornAt) / 850);
      const alpha = Math.min(1, (1 - t) * 3);
      const scale = REDUCED_MOTION.matches ? 2.1 : 1.4 + 1.4 * (1 - (1 - t) ** 3);
      const g = this.shatterGfx;
      g.lineStyle(sw, 0xdc_e9_f0, alpha * 0.75);
      const cos = Math.cos(hull.rot) * scale;
      const sin = Math.sin(hull.rot) * scale;
      for (let i = 0; i < hull.points.length; i++) {
        const a = hull.points[i];
        const b = hull.points[(i + 1) % hull.points.length];
        if (!a || !b) {
          continue;
        }
        g.lineBetween(
          hull.x + a.x * cos - a.y * sin,
          hull.y + a.x * sin + a.y * cos,
          hull.x + b.x * cos - b.y * sin,
          hull.y + b.x * sin + b.y * cos,
        );
      }
      this.hullText
        .setPosition(hull.x, hull.y + 42 * sw)
        .setScale(sw)
        .setAlpha(alpha)
        .setVisible(t < 1);
      if (t >= 1) {
        this.hullCue = null;
      }
    } else {
      this.hullText.setVisible(false);
    }

    const boss = this.bossCue;
    if (boss) {
      const t = Math.min(1, (now - boss.bornAt) / 1000);
      const alpha = Math.min(1, (1 - t) * 2.5);
      const radius = REDUCED_MOTION.matches ? 74 : 58 + 30 * t;
      const g = this.ringGfx;
      g.lineStyle(sw, boss.tint, alpha * 0.8);
      for (let i = 0; i < 4; i++) {
        const angle = Math.PI / 4 + (i * Math.PI) / 2;
        const x = boss.x + Math.cos(angle) * radius;
        const y = boss.y + Math.sin(angle) * radius;
        const dx = Math.sign(Math.cos(angle)) * 12;
        const dy = Math.sign(Math.sin(angle)) * 12;
        g.lineBetween(x - dx, y, x, y);
        g.lineBetween(x, y, x, y - dy);
      }
      this.bossText
        .setPosition(boss.x, boss.y - 68 * sw)
        .setScale(sw)
        .setAlpha(alpha)
        .setVisible(t < 1);
      if (t >= 1) {
        this.bossCue = null;
      }
    } else {
      this.bossText.setVisible(false);
    }
  }
}
