import type Phaser from "phaser";
import { BlendModes } from "phaser";

import { TILE } from "../shared/constants";

interface Mark {
  image: Phaser.GameObjects.Image;
  kind: "core" | "scorch";
  left: number;
  life: number;
}

/** Scene-owned cosmetic budget. Existing fire sprites remain the hazard.
 * No per-explosion emitters, timers, tweens or full-screen passes. */
export class BattleFx {
  private readonly embers: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly smoke: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly chips: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly marks: Mark[] = [];
  private nextMark = 0;

  constructor(scene: Phaser.Scene) {
    // Phaser 4's maxParticles counts reserved dead particles too and blocks
    // reuse at that limit. Preallocate the live cap instead; it bounds both
    // allocation and simultaneous particles without disabling the emitter.
    this.embers = scene.add
      .particles(0, 0, "spark", {
        alpha: { end: 0, start: 1 },
        angle: { max: 335, min: 205 },
        blendMode: BlendModes.ADD,
        emitting: false,
        gravityY: 100,
        lifespan: { max: 350, min: 160 },
        maxAliveParticles: 160,
        scale: { end: 0, start: 0.2 },
        speed: { max: 125, min: 25 },
        tint: [0xff_e9_a0, 0xff_bd_53, 0xff_7e_35],
      })
      .setDepth(32)
      .reserve(160);
    this.smoke = scene.add
      .particles(0, 0, "spark", {
        alpha: { end: 0, start: 0.24 },
        angle: { max: 310, min: 230 },
        blendMode: BlendModes.NORMAL,
        emitting: false,
        lifespan: { max: 620, min: 350 },
        maxAliveParticles: 64,
        scale: { end: 1.1, start: 0.55 },
        speed: { max: 20, min: 5 },
        tint: 0x32_2e_2b,
      })
      .setDepth(3)
      .reserve(64);
    this.chips = scene.add
      .particles(0, 0, "chip", {
        alpha: { end: 0, start: 1 },
        angle: { max: 335, min: 205 },
        emitting: false,
        gravityY: 350,
        lifespan: { max: 450, min: 230 },
        maxAliveParticles: 96,
        rotate: { max: 180, min: -180 },
        scale: { end: 0.3, start: 1 },
        speed: { max: 170, min: 65 },
        tint: [0xbb_78_3c, 0xe3_ae_68, 0x87_51_2c],
      })
      .setDepth(5)
      .reserve(96);
    for (let i = 0; i < 64; i += 1) {
      this.marks.push({
        image: scene.add.image(0, 0, "glow").setVisible(false),
        kind: "scorch",
        left: 0,
        life: 1,
      });
    }
  }

  fuse(x: number, y: number): void {
    this.embers.explode(1, x, y);
  }

  blast(tiles: readonly { col: number; row: number }[], reducedMotion: boolean): void {
    for (const [index, tile] of tiles.entries()) {
      const x = (tile.col + 0.5) * TILE;
      const y = (tile.row + 0.5) * TILE;
      this.mark(x, y, "scorch");
      this.embers.explode(reducedMotion ? 1 : 3, x, y);
      if (!reducedMotion) {
        this.smoke.explode(1, x, y);
      }
      if (index === 0 && !reducedMotion) {
        this.mark(x, y, "core");
      }
    }
  }

  crate(x: number, y: number, reducedMotion: boolean): void {
    this.chips.explode(reducedMotion ? 3 : 7, x, y);
    if (!reducedMotion) {
      this.smoke.explode(2, x, y);
    }
  }

  update(delta: number): void {
    for (const mark of this.marks) {
      if (mark.left <= 0) {
        continue;
      }
      mark.left = Math.max(0, mark.left - delta);
      const progress = mark.left / mark.life;
      mark.image.setAlpha(progress * (mark.kind === "core" ? 0.7 : 0.24));
      if (mark.left === 0) {
        mark.image.setVisible(false);
      }
    }
  }

  clear(): void {
    this.embers.killAll();
    this.smoke.killAll();
    this.chips.killAll();
    for (const mark of this.marks) {
      mark.left = 0;
      mark.image.setVisible(false);
    }
  }

  private mark(x: number, y: number, kind: Mark["kind"]): void {
    const mark = this.marks[this.nextMark];
    this.nextMark = (this.nextMark + 1) % this.marks.length;
    if (!mark) {
      return;
    }
    mark.kind = kind;
    mark.life = kind === "core" ? 95 : 1700;
    mark.left = mark.life;
    mark.image
      .setTexture(kind === "core" ? "glow" : "shadow")
      .setPosition(x, y)
      .setDisplaySize(TILE * 0.8, TILE * (kind === "core" ? 0.8 : 0.52))
      .setTint(kind === "core" ? 0xff_e8_aa : 0x3c_2a_20)
      .setBlendMode(kind === "core" ? BlendModes.ADD : BlendModes.NORMAL)
      .setDepth(kind === "core" ? 31 : -1)
      .setAlpha(kind === "core" ? 0.7 : 0.24)
      .setVisible(true);
  }
}
