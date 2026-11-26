import type Phaser from "phaser";
import { BlendModes, Scale } from "phaser";

const BARRIER_CORE_TINT = 0x6f_f7_ff;
const BARRIER_BLOOM_TINT = 0xb2_4b_ff;
const BARRIER_PULSE_HZ = 0.5;
const VIGNETTE_STRENGTH = 0.55;
const VIGNETTE_BAND = 0.22;
const VIGNETTE_STEPS = 8;

/**
 * The world boundary, drawn as a glowing neon energy frame (world-space additive
 * Graphics at depth 49 — just under the black masks at 50) plus a screen-space
 * vignette that seats the playfield against the bled outer starfield so the edge
 * never reads as a hard cut.
 *
 * Reconstructed in create(); call destroy() on the prior instance first to avoid
 * leaked Graphics on scene reuse (Phaser keeps scene instances around).
 */
export class EnergyBarrier {
  private readonly frame: Phaser.GameObjects.Graphics;
  /** Screen-space dark frame. Public: the scene counter-transforms it against
   *  camera zoom/roll along with its other screen-fixed objects. */
  readonly vignette: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene) {
    this.frame = scene.add.graphics().setDepth(49).setBlendMode(BlendModes.ADD);
    this.vignette = scene.add.graphics().setScrollFactor(0).setDepth(91);
    scene.scale.on(Scale.Events.RESIZE, this.drawVignette, this);
    this.drawVignette();
  }

  /** Animated; call from scene.update() with the scene clock (ms) and the live
   *  play bounds (the barrier marks the play area, which grows with players). */
  update(timeMs: number, worldW: number, worldH: number) {
    const t = timeMs / 1000;
    const pulse = 0.75 + 0.25 * Math.sin(t * BARRIER_PULSE_HZ * Math.PI * 2);
    const g = this.frame;
    g.clear();
    g.lineStyle(26, BARRIER_BLOOM_TINT, 0.1 * pulse).strokeRect(0, 0, worldW, worldH);
    g.lineStyle(10, BARRIER_CORE_TINT, 0.22 * pulse).strokeRect(0, 0, worldW, worldH);
    g.lineStyle(2, 0xff_ff_ff, 0.85 * pulse).strokeRect(0, 0, worldW, worldH);
    const span = 600;
    const fx = ((timeMs * 0.25) % (worldW + span)) - span;
    const fy = ((timeMs * 0.25) % (worldH + span)) - span;
    g.lineStyle(3, BARRIER_CORE_TINT, 0.5 * pulse);
    g.lineBetween(fx, 0, fx + span, 0);
    g.lineBetween(worldW - fx, worldH, worldW - fx - span, worldH);
    g.lineBetween(0, fy, 0, fy + span);
    g.lineBetween(worldW, worldH - fy, worldW, worldH - fy - span);

    for (let i = 1; i <= 4; i += 1) {
      const inset = i * 14;
      g.lineStyle(2, BARRIER_CORE_TINT, 0.06 * (1 - i / 5) * pulse).strokeRect(
        inset,
        inset,
        worldW - inset * 2,
        worldH - inset * 2,
      );
    }

    g.fillStyle(0xff_ff_ff, 0.7 * pulse);

    for (const [cx, cy] of [
      [0, 0],
      [worldW, 0],
      [0, worldH],
      [worldW, worldH],
    ] as const) {
      g.fillCircle(cx, cy, 4 + 2 * pulse);
    }
  }

  private drawVignette() {
    const w = this.frame.scene.scale.width;
    const h = this.frame.scene.scale.height;
    const band = Math.min(w, h) * VIGNETTE_BAND;
    const v = this.vignette;
    v.clear();

    for (let i = 0; i < VIGNETTE_STEPS; i += 1) {
      const f = i / VIGNETTE_STEPS;
      const a = VIGNETTE_STRENGTH * (1 - f) * (1 - f);
      const o = band * f;
      const thick = band / VIGNETTE_STEPS + 1;
      v.fillStyle(0x02_06_17, a);
      v.fillRect(0, o, w, thick);
      v.fillRect(0, h - o - thick, w, thick);
      v.fillRect(o, 0, thick, h);
      v.fillRect(w - o - thick, 0, thick, h);
    }
  }

  destroy() {
    this.frame.scene.scale.off(Scale.Events.RESIZE, this.drawVignette, this);
    this.frame.destroy();
    this.vignette.destroy();
  }
}
