import type Phaser from "phaser";

import { WORLD_BLEED_PX, WORLD_H, WORLD_W } from "../shared/constants";

const STAR_TINTS = [
  0xff_ff_ff, 0xff_ff_aa, 0xaa_aa_ff, 0xff_aa_aa, 0xaa_ff_aa, 0xff_aa_ff, 0xaa_ff_ff,
];
// stars per px² (~1327 over the 4× world)
const STAR_DENSITY = 0.00004;
const STAR_PX = 5;
/** Outer-ring density (~30% of STAR_DENSITY): stars fade into the void past the
 *  world edge instead of stopping dead, so the arena never looks hard-cut. */
const BLEED_DENSITY = 0.000012;
/** Far-parallax layer: sparse, dim, scrollFactor < 1 for depth. */
const PARALLAX_DENSITY = 0.000006;
const PARALLAX_SCROLL = 0.35;
const PARALLAX_DEPTH = -1;
const PARALLAX_PX = 3;
const PARALLAX_ALPHA = 0.4;
/** Inflated playfield rect: the world plus the bleed band on every side. */
const FIELD_X0 = -WORLD_BLEED_PX;
const FIELD_Y0 = -WORLD_BLEED_PX;
const FIELD_W = WORLD_W + WORLD_BLEED_PX * 2;
const FIELD_H = WORLD_H + WORLD_BLEED_PX * 2;
const TWINKLE_CHANCE = 0.7;
/** Twinklers alternate bright/dim every 2–4s. */
const TWINKLE_HALF_MS_MIN = 2000;
const TWINKLE_HALF_MS_MAX = 4000;
const DIM_FACTOR = 0.3;
const REGEN_INTERVAL_MS = 5000;
const REGEN_FRACTION = 0.15;

const SHOOT_PX = 2;
const SHOOT_SPAWN_MS_MIN = 2000;
const SHOOT_SPAWN_MS_MAX = 5000;
// px/s (legacy 3–5 px/tick)
const SHOOT_SPEED_MIN = 180;
const SHOOT_SPEED_MAX = 300;
// px between trail points
const SHOOT_TRAIL_SPACING = 8;
// alpha/s (legacy 0.1/tick)
const SHOOT_TRAIL_FADE_PER_S = 6;
// rgba(180, 242, 255)
const SHOOT_TINT = 0xb4_f2_ff;
/** Head: 4×2 block of 2px pixels minus two corner pixels. */
const SHOOT_HEAD_PIXELS: readonly (readonly [number, number])[] = [
  [1, 0],
  [2, 0],
  [3, 0],
  [0, 1],
  [1, 1],
  [2, 1],
];

interface Star {
  img: Phaser.GameObjects.Image;
  base: number;
  twinkle: boolean;
  halfMs: number;
  phaseMs: number;
  dim: boolean;
}

interface TrailPoint {
  x: number;
  y: number;
  alpha: number;
}

interface ShootingStar {
  x: number;
  y: number;
  // rad, 45–135° (downward)
  angle: number;
  speed: number;
  sinceTrail: number;
  trail: TrailPoint[];
}

// ---- module helpers (pure) ------------------------------------------------------

const randBetween = (min: number, max: number): number => min + Math.random() * (max - min);

const rerollStar = (star: Star): void => {
  const x = Math.floor((FIELD_X0 + Math.random() * FIELD_W) / STAR_PX) * STAR_PX;
  const y = Math.floor((FIELD_Y0 + Math.random() * FIELD_H) / STAR_PX) * STAR_PX;
  // edge: 0 anywhere inside the playfield → 1 at the outer bleed edge.
  const ox = Math.max(0, Math.max(-x, x - WORLD_W));
  const oy = Math.max(0, Math.max(-y, y - WORLD_H));
  const edge = Math.min(1, Math.hypot(ox, oy) / WORLD_BLEED_PX);
  // 1 inside → 0 at the outer edge
  const fade = 1 - edge;
  const tint = STAR_TINTS[Math.floor(Math.random() * STAR_TINTS.length)] ?? 0xff_ff_ff;
  // dimmer outward
  star.base = (0.5 + Math.random() * 0.5) * (0.15 + 0.85 * fade);
  // ring is steady
  star.twinkle = edge < 0.6 && Math.random() < TWINKLE_CHANCE;
  star.halfMs = randBetween(TWINKLE_HALF_MS_MIN, TWINKLE_HALF_MS_MAX);
  star.phaseMs = Math.random() * star.halfMs * 2;
  star.dim = false;
  // smaller outward
  const px = STAR_PX * (0.5 + 0.5 * fade);
  star.img.setPosition(x, y).setDisplaySize(px, px).setTint(tint).setAlpha(star.base);
};

/**
 * World-space pixel starfield: twinkling 5px squares (15% repositioned every
 * 5s) plus chunky shooting stars falling from the top edge.
 */
export class Starfield {
  private scene: Phaser.Scene;
  private stars: Star[] = [];
  private shooters: ShootingStar[] = [];
  private gfx: Phaser.GameObjects.Graphics;
  private regenAcc = 0;
  private shootAcc = 0;
  private nextShootMs = randBetween(SHOOT_SPAWN_MS_MIN, SHOOT_SPAWN_MS_MAX);

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    // Playfield keeps STAR_DENSITY; the bleed ring (inflated area minus the
    // world) uses the sparser BLEED_DENSITY. rerollStar scatters across the
    // full inflated field and dims/shrinks stars toward the outer edge.
    const playfieldCount = Math.floor(WORLD_W * WORLD_H * STAR_DENSITY);
    const ringCount = Math.floor((FIELD_W * FIELD_H - WORLD_W * WORLD_H) * BLEED_DENSITY);
    for (let i = 0; i < playfieldCount + ringCount; i += 1) {
      const img = scene.add
        .image(0, 0, "star")
        .setOrigin(0)
        .setDisplaySize(STAR_PX, STAR_PX)
        .setDepth(0);
      const star: Star = { base: 1, dim: false, halfMs: 1, img, phaseMs: 0, twinkle: false };
      rerollStar(star);
      this.stars.push(star);
    }
    // Far-parallax layer: static, dim, drifts slower than the world for depth.
    const pCount = Math.floor(FIELD_W * FIELD_H * PARALLAX_DENSITY);
    for (let i = 0; i < pCount; i += 1) {
      const x = FIELD_X0 + Math.random() * FIELD_W;
      const y = FIELD_Y0 + Math.random() * FIELD_H;
      scene.add
        .image(x, y, "star")
        .setOrigin(0)
        .setDisplaySize(PARALLAX_PX, PARALLAX_PX)
        .setScrollFactor(PARALLAX_SCROLL)
        .setDepth(PARALLAX_DEPTH)
        .setAlpha(PARALLAX_ALPHA * (0.4 + Math.random() * 0.6))
        .setTint(STAR_TINTS[Math.floor(Math.random() * STAR_TINTS.length)] ?? 0xff_ff_ff);
    }
    this.gfx = scene.add.graphics().setDepth(1);
  }

  update(dt: number, timeMs: number): void {
    for (const star of this.stars) {
      if (!star.twinkle) {
        continue;
      }
      const dim = Math.floor((timeMs + star.phaseMs) / star.halfMs) % 2 === 1;
      // ~1000 twinklers; alpha only flips every 2-4s, so skip the no-op sets
      if (dim !== star.dim) {
        star.dim = dim;
        star.img.setAlpha(dim ? star.base * DIM_FACTOR : star.base);
      }
    }

    this.regenAcc += dt * 1000;
    if (this.regenAcc >= REGEN_INTERVAL_MS) {
      this.regenAcc = 0;
      const n = Math.max(1, Math.floor(this.stars.length * REGEN_FRACTION));
      for (let i = 0; i < n; i += 1) {
        const star = this.stars[Math.floor(Math.random() * this.stars.length)];
        if (star) {
          rerollStar(star);
        }
      }
    }

    this.shootAcc += dt * 1000;
    if (this.shootAcc >= this.nextShootMs) {
      this.shootAcc = 0;
      this.nextShootMs = randBetween(SHOOT_SPAWN_MS_MIN, SHOOT_SPAWN_MS_MAX);
      this.shooters.push({
        angle: ((45 + Math.random() * 90) * Math.PI) / 180,
        sinceTrail: 0,
        speed: randBetween(SHOOT_SPEED_MIN, SHOOT_SPEED_MAX),
        trail: [],
        x: Math.random() * WORLD_W,
        y: 0,
      });
    }

    this.shooters = this.shooters.filter((s) => {
      const step = s.speed * dt;
      s.sinceTrail += step;
      if (s.sinceTrail >= SHOOT_TRAIL_SPACING) {
        s.sinceTrail %= SHOOT_TRAIL_SPACING;
        s.trail.push({ alpha: 1, x: s.x, y: s.y });
      }
      s.x += Math.cos(s.angle) * step;
      s.y += Math.sin(s.angle) * step;
      for (const p of s.trail) {
        p.alpha -= SHOOT_TRAIL_FADE_PER_S * dt;
      }
      s.trail = s.trail.filter((p) => p.alpha > 0);
      return s.x >= -30 && s.x <= WORLD_W + 30 && s.y >= -30 && s.y <= WORLD_H + 30;
    });

    this.gfx.clear();
    for (const s of this.shooters) {
      for (const p of s.trail) {
        this.gfx.fillStyle(SHOOT_TINT, p.alpha);
        this.gfx.fillRect(p.x, p.y, SHOOT_PX, SHOOT_PX);
      }
      const cos = Math.cos(s.angle);
      const sin = Math.sin(s.angle);
      this.gfx.fillStyle(0xff_ff_ff, 1);
      for (const [px, py] of SHOOT_HEAD_PIXELS) {
        const ox = px * SHOOT_PX;
        const oy = py * SHOOT_PX;
        this.gfx.fillRect(s.x + ox * cos - oy * sin, s.y + ox * sin + oy * cos, SHOOT_PX, SHOOT_PX);
      }
    }
  }
}
