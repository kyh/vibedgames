// The paint grid as a texture the road shader samples by world position.
//
// RGB carries the painter's colour scaled by how fresh the coat is; alpha is
// plain coverage. Sampling is bilinear, so thresholding the blurred coverage
// in the shader turns square cells into round-edged strokes, and dividing RGB
// by it recovers a clean colour right up to the edge.

import * as THREE from "three";

import { PAINT_CELL, PAINT_SIZE } from "../shared/constants";
import type { PaintGrid } from "../sim/paint";

/** Colours a slot can take; slot 0 is bare road. */
const MAX_SLOTS = 32;

export class PaintLayer {
  readonly texture: THREE.DataTexture;
  /** World units the texture spans, for the shader's UV. */
  readonly span = PAINT_SIZE * PAINT_CELL;
  private readonly data = new Uint8Array(PAINT_SIZE * PAINT_SIZE * 4);
  private readonly palette = new Float32Array(MAX_SLOTS * 3);
  private seen = -1;

  constructor() {
    this.texture = new THREE.DataTexture(this.data, PAINT_SIZE, PAINT_SIZE, THREE.RGBAFormat);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  setColor(slot: number, color: THREE.Color): void {
    if (slot > 0 && slot < MAX_SLOTS) {
      this.palette.set([color.r, color.g, color.b], slot * 3);
      // Repaint existing strokes in the new colour on the next upload.
      this.seen = -1;
    }
  }

  /** Copy the grid into the texture if it changed since the last upload. */
  upload(grid: PaintGrid): void {
    if (grid.version === this.seen) {
      return;
    }
    this.seen = grid.version;
    const { owner, strength } = grid;
    const { data, palette } = this;
    for (let cell = 0; cell < owner.length; cell += 1) {
      const slot = owner[cell] ?? 0;
      const o = cell * 4;
      if (slot === 0) {
        data[o + 3] = 0;
      } else {
        // Fresh paint is full-bright; it dims to a third before it is gone.
        const glow = 255 * (0.3 + 0.7 * (strength[cell] ?? 0));
        const p = slot * 3;
        data[o] = (palette[p] ?? 0) * glow;
        data[o + 1] = (palette[p + 1] ?? 0) * glow;
        data[o + 2] = (palette[p + 2] ?? 0) * glow;
        data[o + 3] = 255;
      }
    }
    this.texture.needsUpdate = true;
  }
}
