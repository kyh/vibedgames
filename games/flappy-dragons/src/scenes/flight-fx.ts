import type Phaser from "phaser";
import { COURSE_H } from "../shared/constants";

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

export function prefersReducedMotion(): boolean {
  return REDUCED_MOTION.matches;
}

interface Ring {
  image: Phaser.GameObjects.Image;
  age: number;
}

const RING_LIFE_S = 0.38;
const LEAF_EVERY_S = 0.9;
const TRAIL_EVERY_S = 0.12;
const NOTICE_S = 1.5;

/** Local flight decoration only. Fixed particle/ring budgets; no gameplay timers. */
export class FlightFx {
  private readonly air: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly leaves: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly rings: Ring[] = [];
  private readonly notice: Phaser.GameObjects.Text;
  private leafIn = 0;
  private trailIn = 0;
  private noticeLeft = 0;

  constructor(scene: Phaser.Scene) {
    // Phaser 4 checks maxParticles before reusing dead slots. Reserve the pool
    // and cap only live particles so a full burst can expire and fire again.
    this.air = scene.add
      .particles(0, 0, "flight-puff", {
        alpha: { end: 0, start: 0.7 },
        emitting: false,
        lifespan: { max: 420, min: 220 },
        maxAliveParticles: 36,
        scale: { end: 0, start: 1 },
        speedX: { max: -30, min: -100 },
        speedY: { max: 100, min: 25 },
        tint: 0xe7faff,
      })
      .reserve(36)
      .setDepth(9);
    this.sparks = scene.add
      .particles(0, 0, "flight-glint", {
        alpha: { end: 0, start: 1 },
        angle: { max: 340, min: 200 },
        emitting: false,
        gravityY: 170,
        lifespan: { max: 650, min: 350 },
        maxAliveParticles: 64,
        scale: { end: 0, start: 1 },
        speed: { max: 150, min: 45 },
        tint: 0xffdc70,
      })
      .reserve(64)
      .setDepth(15);
    this.leaves = scene.add
      .particles(0, 0, "flight-leaf", {
        alpha: { end: 0, start: 0.32 },
        emitting: false,
        lifespan: 6500,
        maxAliveParticles: 12,
        rotate: { end: 130, start: -30 },
        scale: { end: 0.6, start: 1 },
        speedX: { max: -16, min: -34 },
        speedY: { max: 18, min: 8 },
        tint: [0xa5cf78, 0xffe49b, 0xc4eab8],
      })
      .reserve(12)
      .setDepth(-1);
    for (let i = 0; i < 5; i++) {
      this.rings.push({
        age: 1,
        image: scene.add.image(0, 0, "flight-ring").setDepth(14).setVisible(false),
      });
    }
    this.notice = scene.add
      .text(0, 0, "", {
        align: "center",
        color: "#fff2a6",
        fontFamily: '"Courier New", monospace',
        fontSize: "18px",
        fontStyle: "bold",
        stroke: "#392454",
        strokeThickness: 5,
      })
      .setOrigin(0.5, 0)
      .setDepth(22)
      .setVisible(false);
  }

  wingbeat(x: number, y: number): void {
    if (!prefersReducedMotion()) {
      this.air.explode(5, x - 20, y + 22);
    }
  }

  pickup(x: number, y: number): void {
    this.burst(0xff_dc_70, 14, x, y);
    this.ring(x, y, 0xff_e8_99);
  }

  pass(x: number, y: number): void {
    this.burst(0xd8_f6_b5, 6, x, y);
  }

  crash(x: number, y: number): void {
    this.burst(0xe4_f5_ff, 16, x, y);
    this.ring(x, y, 0xe4_f5_ff);
  }

  celebrate(text: string, x: number, y: number): void {
    this.notice.setText(text).setVisible(true).setAlpha(1);
    this.noticeLeft = NOTICE_S;
    this.burst(0xff_dc_70, 22, x, y);
    this.ring(x, y, 0xff_e8_99);
  }

  private burst(tint: number, count: number, x: number, y: number): void {
    this.sparks.setParticleTint(tint).explode(prefersReducedMotion() ? 3 : count, x, y);
  }

  private ring(x: number, y: number, color: number): void {
    if (prefersReducedMotion()) {
      return;
    }
    let ring = this.rings[0];
    for (const candidate of this.rings) {
      if (!candidate.image.visible) {
        ring = candidate;
        break;
      }
    }
    if (!ring) {
      return;
    }
    ring.age = 0;
    ring.image.setPosition(x, y).setTint(color).setScale(0.4).setAlpha(0.85).setVisible(true);
  }

  /** `noticeY` is the logical y under the score digits; `climbing` drives the wing trail. */
  update(
    dt: number,
    viewW: number,
    viewTop: number,
    noticeY: number,
    birdX: number,
    birdY: number,
    climbing: boolean,
  ): void {
    this.leafIn -= dt;
    this.trailIn -= dt;
    const reduced = prefersReducedMotion();
    if (reduced) {
      this.air.killAll();
      this.leaves.killAll();
    } else {
      if (this.leafIn <= 0) {
        this.leafIn = LEAF_EVERY_S;
        this.leaves.explode(
          1,
          Math.random() * viewW,
          viewTop + Math.random() * (COURSE_H - viewTop),
        );
      }
      if (climbing && this.trailIn <= 0) {
        this.trailIn = TRAIL_EVERY_S;
        this.air.explode(1, birdX - 28, birdY + 15);
      }
    }
    for (const ring of this.rings) {
      if (!ring.image.visible) {
        continue;
      }
      ring.age += dt / RING_LIFE_S;
      ring.image.setVisible(ring.age < 1 && !reduced);
      ring.image.setScale(0.4 + Math.min(1, ring.age) * 1.6);
      ring.image.setAlpha(Math.max(0, (1 - ring.age) * 0.85));
    }
    this.noticeLeft = Math.max(0, this.noticeLeft - dt);
    this.notice.setPosition(viewW / 2, noticeY);
    this.notice.setVisible(this.noticeLeft > 0).setAlpha(Math.min(1, this.noticeLeft / 0.3));
  }

  reset(): void {
    this.air.killAll();
    this.sparks.killAll();
    for (const ring of this.rings) {
      ring.image.setVisible(false);
    }
    this.noticeLeft = 0;
    this.notice.setVisible(false);
  }
}
