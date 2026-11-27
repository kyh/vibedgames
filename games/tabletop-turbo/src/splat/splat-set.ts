export const FLAG = {
  bright: 64,
  noShadow: 8,
  paintable: 4,
  pulse: 32,
  round: 16,
  twoSided: 2,
  unlit: 1,
} as const;

export class SplatSet {
  centers: Float32Array;
  normals: Int8Array;
  data: Uint8Array;
  count = 0;
  private readonly fixed: boolean;

  constructor(capacity = 4096, fixed = false) {
    this.fixed = fixed;
    this.centers = new Float32Array(capacity * 3);
    this.normals = new Int8Array(capacity * 4);
    this.data = new Uint8Array(capacity * 4);
  }

  get capacity() {
    return this.data.length / 4;
  }

  clear() {
    this.count = 0;
  }

  /** One disc at (x, y, z) facing (nx, ny, nz), `sigma` world units wide. */
  push(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    sigma: number,
    tone: number,
    flags: number,
  ) {
    if (this.count >= this.capacity) {
      if (this.fixed) {
        return;
      }

      this.grow();
    }

    const i = this.count;
    this.centers[i * 3] = x;
    this.centers[i * 3 + 1] = y;
    this.centers[i * 3 + 2] = z;
    this.normals[i * 4] = Math.round(nx * 127);
    this.normals[i * 4 + 1] = Math.round(ny * 127);
    this.normals[i * 4 + 2] = Math.round(nz * 127);
    this.data[i * 4] = Math.min(255, Math.round(sigma * 100));
    this.data[i * 4 + 1] = Math.floor(tone / 8);
    this.data[i * 4 + 2] = tone % 8;
    this.data[i * 4 + 3] = flags;
    this.count += 1;
  }

  private grow() {
    const next = this.capacity * 2;
    const centers = new Float32Array(next * 3);
    const normals = new Int8Array(next * 4);
    const data = new Uint8Array(next * 4);
    centers.set(this.centers);
    normals.set(this.normals);
    data.set(this.data);
    this.centers = centers;
    this.normals = normals;
    this.data = data;
  }
}

/** A tone id: a ramp and a step on it. */
export const tone = (ramp: number, step: number) => ramp * 8 + step;
