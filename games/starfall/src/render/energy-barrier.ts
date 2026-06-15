import Phaser from "phaser";

const BARRIER_CORE_TINT = 0x6ff7ff; // hot cyan core — energized arcade neon
const BARRIER_BLOOM_TINT = 0xb24bff; // magenta outer bloom (cyan/magenta = retro neon)
const BARRIER_PULSE_HZ = 0.5; // slow breath, one pulse per 2s
const VIGNETTE_STRENGTH = 0.55; // max alpha of the screen-edge darkening
const VIGNETTE_BAND = 0.22; // dark band span as a fraction of min(screen w,h)
const VIGNETTE_STEPS = 8; // gradient resolution (cheap, no shader)

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
  private frame: Phaser.GameObjects.Graphics; // world-space neon rect + inner glow
  private vignette: Phaser.GameObjects.Graphics; // screen-space dark frame

  constructor(scene: Phaser.Scene) {
    this.frame = scene.add.graphics().setDepth(49).setBlendMode(Phaser.BlendModes.ADD);
    this.vignette = scene.add.graphics().setScrollFactor(0).setDepth(91);
    scene.scale.on(Phaser.Scale.Events.RESIZE, this.drawVignette, this);
    this.drawVignette();
  }

  /** Animated; call from scene.update() with the scene clock (ms) and the live
   *  play bounds (the barrier marks the play area, which grows with players). */
  update(timeMs: number, worldW: number, worldH: number): void {
    const t = timeMs / 1000;
    const pulse = 0.75 + 0.25 * Math.sin(t * BARRIER_PULSE_HZ * Math.PI * 2);
    const g = this.frame;
    g.clear();
    // Outer bloom → core: three stroked passes on the play rect.
    g.lineStyle(26, BARRIER_BLOOM_TINT, 0.1 * pulse).strokeRect(0, 0, worldW, worldH);
    g.lineStyle(10, BARRIER_CORE_TINT, 0.22 * pulse).strokeRect(0, 0, worldW, worldH);
    g.lineStyle(2, 0xffffff, 0.85 * pulse).strokeRect(0, 0, worldW, worldH);
    // Scanline shimmer: a bright segment traveling along each edge.
    const span = 600;
    const fx = ((timeMs * 0.25) % (worldW + span)) - span;
    const fy = ((timeMs * 0.25) % (worldH + span)) - span;
    g.lineStyle(3, BARRIER_CORE_TINT, 0.5 * pulse);
    g.lineBetween(fx, 0, fx + span, 0);
    g.lineBetween(worldW - fx, worldH, worldW - fx - span, worldH);
    g.lineBetween(0, fy, 0, fy + span);
    g.lineBetween(worldW, worldH - fy, worldW, worldH - fy - span);
    // Inner-edge fade: faint additive strokes stepping inward (playfield glow).
    for (let i = 1; i <= 4; i++) {
      const inset = i * 14;
      g.lineStyle(2, BARRIER_CORE_TINT, 0.06 * (1 - i / 5) * pulse).strokeRect(
        inset,
        inset,
        worldW - inset * 2,
        worldH - inset * 2,
      );
    }
    // Corner node accents.
    g.fillStyle(0xffffff, 0.7 * pulse);
    for (const [cx, cy] of [
      [0, 0],
      [worldW, 0],
      [0, worldH],
      [worldW, worldH],
    ] as const) {
      g.fillCircle(cx, cy, 4 + 2 * pulse);
    }
  }

  /** Screen-space vignette: stepped alpha strips darken the frame edges. Cheap,
   *  scrollFactor 0, redrawn only on resize. */
  private drawVignette(): void {
    const w = this.frame.scene.scale.width;
    const h = this.frame.scene.scale.height;
    const band = Math.min(w, h) * VIGNETTE_BAND;
    const v = this.vignette;
    v.clear();
    for (let i = 0; i < VIGNETTE_STEPS; i++) {
      const f = i / VIGNETTE_STEPS; // 0 outer → 1 inner
      const a = VIGNETTE_STRENGTH * (1 - f) * (1 - f);
      const o = band * f; // inset of this step
      const thick = band / VIGNETTE_STEPS + 1; // strip thickness (>= 1px)
      v.fillStyle(0x020617, a);
      v.fillRect(0, o, w, thick); // top
      v.fillRect(0, h - o - thick, w, thick); // bottom
      v.fillRect(o, 0, thick, h); // left
      v.fillRect(w - o - thick, 0, thick, h); // right
    }
  }

  destroy(): void {
    this.frame.scene.scale.off(Phaser.Scale.Events.RESIZE, this.drawVignette, this);
    this.frame.destroy();
    this.vignette.destroy();
  }
}
