/** Flat-coloured discs drawn straight onto the art grid: sparks, smoke, beams, marks on the floor. */
export class DabSet {
  readonly centers: Float32Array;
  readonly data: Uint8Array;
  count = 0;

  constructor(capacity = 4096) {
    this.centers = new Float32Array(capacity * 3);
    this.data = new Uint8Array(capacity * 4);
  }

  get capacity() {
    return this.data.length / 4;
  }

  clear() {
    this.count = 0;
  }

  /**
   * One disc at (x, y, z), `size` world units across its middle. `flat` lays it
   * on the floor; `rim` inks its edge once it is big enough to carry a line.
   */
  push(x: number, y: number, z: number, size: number, tone: number, flat = false, rim = false) {
    if (this.count >= this.capacity) {
      return;
    }

    const i = this.count;
    this.centers[i * 3] = x;
    this.centers[i * 3 + 1] = y;
    this.centers[i * 3 + 2] = z;
    this.data[i * 4] = Math.min(255, Math.round(size * 100));
    this.data[i * 4 + 1] = Math.floor(tone / 8);
    this.data[i * 4 + 2] = tone % 8;
    this.data[i * 4 + 3] = (flat ? 2 : 0) + (rim ? 32 : 0);
    this.count += 1;
  }
}
