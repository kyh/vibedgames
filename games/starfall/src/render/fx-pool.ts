import type Phaser from "phaser";
import { BlendModes } from "phaser";

import type { Vec } from "../shared/constants";

// Pooled VFX (vfx skill rules): the two particle emitters are created ONCE and
// fired with explode(); stroke-shatter groups, shockwave rings and converge
// motes are plain data drawn into two shared Graphics layers per frame
// (ADD = energy, NORMAL = matter → exactly 2 batches + 2 textures).

/** Hard cap on live particles across both emitters. */
const PARTICLE_BUDGET = 400;
/** Trail emitters throttle ×2 above this (v2: earlier, for the bigger crowds). */
export const PARTICLE_SOFT_BUDGET = 280;
/** Skip non-kill hit-spark spawns above this (keep the white victim flash). */
export const HITSPARK_SKIP_BUDGET = 340;
/** Skip spawning effects further than this outside the camera rect. */
const OFFSCREEN_PAD = 100;
const MAX_SHATTER_GROUPS = 12;
/** NOVA pulses + mine blasts are ring-hungry; rings are pooled Graphics. */
const MAX_RINGS = 8;
const MAX_CONVERGES = 6;
const SHATTER_LIFE_MS = 500;

interface ShatterSeg {
  // segment half-vector (rotates), midpoint offset from origin (flies outward)
  hx: number;
  hy: number;
  mx: number;
  my: number;
  vx: number;
  vy: number;
  // rad/s
  rotV: number;
  rot: number;
}

interface ShatterGroup {
  x: number;
  y: number;
  tint: number;
  bornAt: number;
  segs: ShatterSeg[];
}

interface Ring {
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
  // degrees
  angleMin?: number;
  angleMax?: number;
  speedMin?: number;
  speedMax?: number;
  lifeMin?: number;
  lifeMax?: number;
  scale?: number;
}

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
      alpha: { end: 0, start: 1 },
      angle: { max: 360, min: 0 },
      blendMode: BlendModes.ADD,
      emitting: false,
      lifespan: { max: 300, min: 150 },
      scale: { end: 0, start: 0.6 },
      speed: { max: 140, min: 30 },
    });
    this.sparkAdd.setDepth(20);
    this.debrisNormal = scene.add.particles(0, 0, "star", {
      alpha: { end: 0, start: 1 },
      angle: { max: 360, min: 0 },
      blendMode: BlendModes.NORMAL,
      emitting: false,
      lifespan: { max: 500, min: 300 },
      rotate: { max: 360, min: 0 },
      scale: { end: 0.2, start: 0.8 },
      speed: { max: 160, min: 60 },
    });
    this.debrisNormal.setDepth(14);
    this.shatterGfx = scene.add.graphics().setDepth(16);
    this.ringGfx = scene.add.graphics().setDepth(21).setBlendMode(BlendModes.ADD);
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
    const n = Math.min(count, Math.max(0, PARTICLE_BUDGET - this.aliveParticles()));
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
    const n = Math.min(count, Math.max(0, PARTICLE_BUDGET - this.aliveParticles()));
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
  ): void {
    if (!this.onScreen(x, y)) {
      return;
    }
    if (this.rings.length >= MAX_RINGS) {
      this.rings.shift();
      // drop oldest
    }
    this.rings.push({ alpha0, bornAt: this.scene.time.now, durMs, r0, r1, tint, x, y });
  }

  /**
   * Stroke-shatter: a closed polygon (points relative to origin, pre-rotated)
   * decomposes into its edge segments — each flies outward 80–200 px/s,
   * rotates ±3 rad/s, fades over 500ms. NORMAL blend, hull tint.
   */
  shatter(x: number, y: number, points: readonly Vec[], rot: number, tint: number): void {
    if (!this.onScreen(x, y) || points.length < 2) {
      return;
    }
    if (this.shatters.length >= MAX_SHATTER_GROUPS) {
      this.shatters.shift();
    }
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const segs: ShatterSeg[] = [];
    for (let i = 0; i < points.length; i += 1) {
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
    this.shatters.push({ bornAt: this.scene.time.now, segs, tint, x, y });
  }

  /** Motes converging inward from radius→0 over durMs (anticipation). */
  converge(x: number, y: number, count: number, radius: number, durMs: number, tint: number): void {
    if (!this.onScreen(x, y)) {
      return;
    }
    if (this.converges.length >= MAX_CONVERGES) {
      this.converges.shift();
    }
    this.converges.push({
      bornAt: this.scene.time.now,
      count,
      durMs,
      radius,
      seed: Math.random() * Math.PI * 2,
      tint,
      x,
      y,
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
      // Cubic.Out
      const eased = 1 - (1 - t) ** 3;
      const radius = r.r0 + (r.r1 - r.r0) * eased;
      rg.lineStyle(1, r.tint, r.alpha0 * (1 - t));
      rg.strokeCircle(r.x, r.y, radius);
    }
    this.converges = this.converges.filter((c) => now - c.bornAt < c.durMs);
    for (const c of this.converges) {
      const t = (now - c.bornAt) / c.durMs;
      const dist = c.radius * (1 - t);
      rg.fillStyle(c.tint, 0.9 * (1 - t * 0.4));
      for (let i = 0; i < c.count; i += 1) {
        const ang = c.seed + (Math.PI * 2 * i) / c.count;
        rg.fillCircle(c.x + Math.cos(ang) * dist, c.y + Math.sin(ang) * dist, 1.5);
      }
    }
  }
}
