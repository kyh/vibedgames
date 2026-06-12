import Phaser from "phaser";

import type { Vec } from "../shared/constants";

// Pooled VFX (vfx skill rules): the two particle emitters are created ONCE and
// fired with explode(); stroke-shatter groups, shockwave rings and converge
// motes are plain data drawn into two shared Graphics layers per frame
// (ADD = energy, NORMAL = matter → exactly 2 batches + 2 textures).

/** Hard cap on live particles across both emitters. */
const PARTICLE_BUDGET = 400;
/** Trail emitters throttle ×2 above this. */
export const PARTICLE_SOFT_BUDGET = 300;
/** Skip spawning effects further than this outside the camera rect. */
const OFFSCREEN_PAD = 100;
const MAX_SHATTER_GROUPS = 12;
const MAX_RINGS = 6;
const MAX_CONVERGES = 6;
const SHATTER_LIFE_MS = 500;

type ShatterSeg = {
  // segment half-vector (rotates), midpoint offset from origin (flies outward)
  hx: number;
  hy: number;
  mx: number;
  my: number;
  vx: number;
  vy: number;
  rotV: number; // rad/s
  rot: number;
};

type ShatterGroup = {
  x: number;
  y: number;
  tint: number;
  bornAt: number;
  segs: ShatterSeg[];
};

type Ring = {
  x: number;
  y: number;
  r0: number;
  r1: number;
  alpha0: number;
  tint: number;
  bornAt: number;
  durMs: number;
};

type Converge = {
  x: number;
  y: number;
  count: number;
  radius: number;
  tint: number;
  bornAt: number;
  durMs: number;
  seed: number;
};

export type SparkOpts = {
  angleMin?: number; // degrees
  angleMax?: number;
  speedMin?: number;
  speedMax?: number;
  lifeMin?: number;
  lifeMax?: number;
  scale?: number;
};

export class FxPool {
  private scene: Phaser.Scene;
  private sparkAdd: Phaser.GameObjects.Particles.ParticleEmitter;
  private debrisNormal: Phaser.GameObjects.Particles.ParticleEmitter;
  private shatterGfx: Phaser.GameObjects.Graphics;
  private ringGfx: Phaser.GameObjects.Graphics;
  private shatters: ShatterGroup[] = [];
  private rings: Ring[] = [];
  private converges: Converge[] = [];

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.sparkAdd = scene.add.particles(0, 0, "spark", {
      speed: { min: 30, max: 140 },
      angle: { min: 0, max: 360 },
      lifespan: { min: 150, max: 300 },
      scale: { start: 0.6, end: 0 },
      alpha: { start: 1, end: 0 },
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    });
    this.sparkAdd.setDepth(20);
    this.debrisNormal = scene.add.particles(0, 0, "star", {
      speed: { min: 60, max: 160 },
      angle: { min: 0, max: 360 },
      lifespan: { min: 300, max: 500 },
      scale: { start: 0.8, end: 0.2 },
      alpha: { start: 1, end: 0 },
      rotate: { min: 0, max: 360 },
      blendMode: Phaser.BlendModes.NORMAL,
      emitting: false,
    });
    this.debrisNormal.setDepth(14);
    this.shatterGfx = scene.add.graphics().setDepth(16);
    this.ringGfx = scene.add.graphics().setDepth(21).setBlendMode(Phaser.BlendModes.ADD);
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
    if (!this.onScreen(x, y)) return;
    const n = Math.min(count, Math.max(0, PARTICLE_BUDGET - this.aliveParticles()));
    if (n <= 0) return;
    const e = this.sparkAdd;
    // Per-burst min/max overrides must go through updateConfig (re-runs
    // loadConfig); the setEmitterAngle/setParticleLifespan/etc. mutators
    // silently no-op for min/max + eased ops in Phaser 4.
    e.updateConfig({
      angle: { min: opts.angleMin ?? 0, max: opts.angleMax ?? 360 },
      speed: { min: opts.speedMin ?? 150, max: opts.speedMax ?? 350 },
      lifespan: { min: opts.lifeMin ?? 150, max: opts.lifeMax ?? 250 },
      scale: { start: opts.scale ?? 0.6, end: 0 },
    });
    e.setParticleTint(tint);
    e.explode(n, x, y);
  }

  /** NORMAL matter debris (star texture). */
  debris(x: number, y: number, count: number, tint: number, opts: SparkOpts = {}): void {
    if (!this.onScreen(x, y)) return;
    const n = Math.min(count, Math.max(0, PARTICLE_BUDGET - this.aliveParticles()));
    if (n <= 0) return;
    const e = this.debrisNormal;
    e.updateConfig({
      angle: { min: opts.angleMin ?? 0, max: opts.angleMax ?? 360 },
      speed: { min: opts.speedMin ?? 60, max: opts.speedMax ?? 160 },
      lifespan: { min: opts.lifeMin ?? 300, max: opts.lifeMax ?? 500 },
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
  ): void {
    if (!this.onScreen(x, y)) return;
    if (this.rings.length >= MAX_RINGS) this.rings.shift(); // drop oldest
    this.rings.push({ x, y, r0, r1, alpha0, tint, bornAt: this.scene.time.now, durMs });
  }

  /**
   * Stroke-shatter: a closed polygon (points relative to origin, pre-rotated)
   * decomposes into its edge segments — each flies outward 80–200 px/s,
   * rotates ±3 rad/s, fades over 500ms. NORMAL blend, hull tint.
   */
  shatter(x: number, y: number, points: ReadonlyArray<Vec>, rot: number, tint: number): void {
    if (!this.onScreen(x, y) || points.length < 2) return;
    if (this.shatters.length >= MAX_SHATTER_GROUPS) this.shatters.shift();
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const segs: ShatterSeg[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (!a || !b) continue;
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
        vx: (mx / outLen) * speed,
        vy: (my / outLen) * speed,
        rotV: (Math.random() * 2 - 1) * 3,
        rot: 0,
      });
    }
    this.shatters.push({ x, y, tint, bornAt: this.scene.time.now, segs });
  }

  /** Motes converging inward from radius→0 over durMs (anticipation). */
  converge(x: number, y: number, count: number, radius: number, durMs: number, tint: number): void {
    if (!this.onScreen(x, y)) return;
    if (this.converges.length >= MAX_CONVERGES) this.converges.shift();
    this.converges.push({
      x,
      y,
      count,
      radius,
      tint,
      bornAt: this.scene.time.now,
      durMs,
      seed: Math.random() * Math.PI * 2,
    });
  }

  /** Redraw all pooled stroke FX. Call once per frame. */
  update(dt: number, now: number): void {
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
      const eased = 1 - Math.pow(1 - t, 3); // Cubic.Out
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
  }
}
