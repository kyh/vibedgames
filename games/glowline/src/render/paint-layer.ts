// The paint grid as two textures the road shader samples by world position.
//
// Colour is sampled nearest, so two drivers' strokes meet at a hard line and
// never blend into mud. Coverage is sampled bilinear and thresholded in the
// shader, which rounds the square cells into brush-like edges. A stroke keeps
// its full colour for most of its life, then its coverage ebbs, so old paint
// thins away instead of turning grey.

import * as THREE from "three";

import { PAINT_CELL, PAINT_SIZE } from "../shared/constants";
import type { PaintGrid } from "../sim/paint";

/** Colours a slot can take; slot 0 is bare road. */
const MAX_SLOTS = 32;
/** Share of a stroke's life over which it thins out at the end. */
const EBB = 0.22;

export class PaintLayer {
  /** RGB: the painter's colour, nearest-sampled. */
  readonly color: THREE.DataTexture;
  /** R: coverage 0–255, bilinear. */
  readonly mask: THREE.DataTexture;
  /** World units the textures span, for the shader's UV. */
  readonly span = PAINT_SIZE * PAINT_CELL;
  private readonly rgb = new Uint8Array(PAINT_SIZE * PAINT_SIZE * 4);
  private readonly cover = new Uint8Array(PAINT_SIZE * PAINT_SIZE);
  private readonly scratch = new Uint8Array(PAINT_SIZE * PAINT_SIZE);
  private readonly palette = new Uint8Array(MAX_SLOTS * 3);
  private seen = -1;

  constructor() {
    this.color = new THREE.DataTexture(this.rgb, PAINT_SIZE, PAINT_SIZE, THREE.RGBAFormat);
    this.color.magFilter = THREE.NearestFilter;
    this.color.minFilter = THREE.NearestFilter;
    this.color.colorSpace = THREE.SRGBColorSpace;
    this.color.needsUpdate = true;
    this.mask = new THREE.DataTexture(this.cover, PAINT_SIZE, PAINT_SIZE, THREE.RedFormat);
    this.mask.magFilter = THREE.LinearFilter;
    this.mask.minFilter = THREE.LinearFilter;
    this.mask.needsUpdate = true;
  }

  setColor(slot: number, color: THREE.Color): void {
    if (slot > 0 && slot < MAX_SLOTS) {
      const hex = color.getHex(THREE.SRGBColorSpace);
      /* oxlint-disable-next-line no-bitwise -- unpacking a 24-bit sRGB hex into bytes */
      this.palette.set([(hex >> 16) & 255, (hex >> 8) & 255, hex & 255], slot * 3);
      // Repaint existing strokes in the new colour on the next upload.
      this.seen = -1;
    }
  }

  /**
   * A 1-2-1 blur of the coverage, across then down. The shader thresholds it
   * at half, so a blurred mask turns the stair-steps of square cells into
   * round, brushed edges.
   */
  private soften(): void {
    const { cover, scratch } = this;
    const n = PAINT_SIZE;
    for (let i = 1; i < cover.length - 1; i += 1) {
      scratch[i] = ((cover[i - 1] ?? 0) + 2 * (cover[i] ?? 0) + (cover[i + 1] ?? 0)) / 4;
    }
    for (let i = n; i < cover.length - n; i += 1) {
      cover[i] = ((scratch[i - n] ?? 0) + 2 * (scratch[i] ?? 0) + (scratch[i + n] ?? 0)) / 4;
    }
  }

  /** Copy the grid into the textures if it changed since the last upload. */
  upload(grid: PaintGrid): void {
    if (grid.version === this.seen) {
      return;
    }
    this.seen = grid.version;
    const { owner, strength } = grid;
    const { cover, palette, rgb } = this;
    for (let cell = 0; cell < owner.length; cell += 1) {
      const slot = owner[cell] ?? 0;
      if (slot === 0) {
        cover[cell] = 0;
      } else {
        const o = cell * 4;
        const p = slot * 3;
        rgb[o] = palette[p] ?? 0;
        rgb[o + 1] = palette[p + 1] ?? 0;
        rgb[o + 2] = palette[p + 2] ?? 0;
        rgb[o + 3] = 255;
        cover[cell] = Math.min(255, ((strength[cell] ?? 0) / EBB) * 255);
      }
    }
    this.soften();
    this.color.needsUpdate = true;
    this.mask.needsUpdate = true;
  }
}
