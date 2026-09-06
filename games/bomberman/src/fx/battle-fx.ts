import Phaser from "phaser";

import { TILE } from "../shared/constants";

type Mark = {
  image: Phaser.GameObjects.Image;
  kind: "core" | "scorch";
  left: number;
  life: number;
};

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
        emitting: false,
        maxAliveParticles: 160,
        speed: { min: 25, max: 125 },
        angle: { min: 205, max: 335 },
        gravityY: 100,
        lifespan: { min: 160, max: 350 },
        scale: { start: 0.2, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [0xffe9a0, 0xffbd53, 0xff7e35],
        blendMode: Phaser.BlendModes.ADD,
      })
      .setDepth(32)
      .reserve(160);
    this.smoke = scene.add
      .particles(0, 0, "spark", {
        emitting: false,
        maxAliveParticles: 64,
        speed: { min: 5, max: 20 },
        angle: { min: 230, max: 310 },
        lifespan: { min: 350, max: 620 },
        scale: { start: 0.55, end: 1.1 },
        alpha: { start: 0.24, end: 0 },
        tint: 0x322e2b,
        blendMode: Phaser.BlendModes.NORMAL,
      })
      .setDepth(3)
      .reserve(64);
    this.chips = scene.add
      .particles(0, 0, "chip", {
        emitting: false,
        maxAliveParticles: 96,
        speed: { min: 65, max: 170 },
        angle: { min: 205, max: 335 },
        gravityY: 350,
        lifespan: { min: 230, max: 450 },
        rotate: { min: -180, max: 180 },
        scale: { start: 1, end: 0.3 },
        alpha: { start: 1, end: 0 },
        tint: [0xbb783c, 0xe3ae68, 0x87512c],
      })
      .setDepth(5)
      .reserve(96);
    for (let i = 0; i < 64; i++) {
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
      if (!reducedMotion) this.smoke.explode(1, x, y);
      if (index === 0 && !reducedMotion) this.mark(x, y, "core");
    }
  }

  crate(x: number, y: number, reducedMotion: boolean): void {
    this.chips.explode(reducedMotion ? 3 : 7, x, y);
    if (!reducedMotion) this.smoke.explode(2, x, y);
  }

  update(delta: number): void {
    for (const mark of this.marks) {
      if (mark.left <= 0) continue;
      mark.left = Math.max(0, mark.left - delta);
      const progress = mark.left / mark.life;
      mark.image.setAlpha(progress * (mark.kind === "core" ? 0.7 : 0.24));
      if (mark.left === 0) mark.image.setVisible(false);
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
    if (!mark) return;
    mark.kind = kind;
    mark.life = kind === "core" ? 95 : 1700;
    mark.left = mark.life;
    mark.image
      .setTexture(kind === "core" ? "glow" : "shadow")
      .setPosition(x, y)
      .setDisplaySize(TILE * 0.8, TILE * (kind === "core" ? 0.8 : 0.52))
      .setTint(kind === "core" ? 0xffe8aa : 0x3c2a20)
      .setBlendMode(kind === "core" ? Phaser.BlendModes.ADD : Phaser.BlendModes.NORMAL)
      .setDepth(kind === "core" ? 31 : -1)
      .setAlpha(kind === "core" ? 0.7 : 0.24)
      .setVisible(true);
  }
}
