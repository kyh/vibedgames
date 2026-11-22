import { SplatSet } from "./splat-set";

/** Picks a tone from a point in the solid's own space; a negative keeps the coat's. */
export type ToneAt = (x: number, y: number, z: number) => number;

export interface Coat {
  tone: number;
  flags?: number;
  at?: ToneAt;
}

type Axis = "x" | "y" | "z";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

const FAT = 0.64;

export class SplatBuilder {
  readonly set: SplatSet;
  readonly spacing: number;
  private seed: number;
  private tx = 0;
  private ty = 0;
  private tz = 0;
  private cos = 1;
  private sin = 0;
  private scale = 1;

  constructor(spacing: number, set = new SplatSet(), seed = 7) {
    this.spacing = spacing;
    this.set = set;
    this.seed = seed;
  }

  /** Everything after this is placed at (x, y, z), turned `yaw` about the vertical. */
  at(x: number, y: number, z: number, yaw = 0, scale = 1) {
    this.tx = x;
    this.ty = y;
    this.tz = z;
    this.cos = Math.cos(yaw);
    this.sin = Math.sin(yaw);
    this.scale = scale;

    return this;
  }

  /** A seeded 0–1, so a bake is the same every time. */
  random() {
    this.seed = (this.seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;

    return this.seed / 4_294_967_296;
  }

  /** One disc in the solid's own space. */
  dab(x: number, y: number, z: number, nx: number, ny: number, nz: number, coat: Coat) {
    const picked = coat.at ? coat.at(x, y, z) : -1;
    const { cos, scale, sin } = this;
    this.set.push(
      this.tx + (cos * x - sin * z) * scale,
      this.ty + y * scale,
      this.tz + (sin * x + cos * z) * scale,
      cos * nx - sin * nz,
      ny,
      sin * nx + cos * nz,
      this.spacing * FAT,
      picked < 0 ? coat.tone : picked,
      coat.flags ?? 0,
    );
  }

  /** A parallelogram from `o` along `u` and `v`, facing `n`. */
  rect(
    o: readonly [number, number, number],
    u: readonly [number, number, number],
    v: readonly [number, number, number],
    n: readonly [number, number, number],
    coat: Coat,
  ) {
    const step = this.spacing / this.scale;
    const nu = Math.max(1, Math.round(Math.hypot(u[0], u[1], u[2]) / step));
    const nv = Math.max(1, Math.round(Math.hypot(v[0], v[1], v[2]) / step));

    for (let i = 0; i < nu; i += 1) {
      for (let j = 0; j < nv; j += 1) {
        const a = (i + 0.5 + (this.random() - 0.5) * 0.5) / nu;
        const b = (j + 0.5 + (this.random() - 0.5) * 0.5) / nv;
        this.dab(
          o[0] + u[0] * a + v[0] * b,
          o[1] + u[1] * a + v[1] * b,
          o[2] + u[2] * a + v[2] * b,
          n[0],
          n[1],
          n[2],
          coat,
        );
      }
    }
  }

  /** A box centred on (cx, cy, cz). The underside is left open: nothing ever sees it. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, coat: Coat) {
    const x0 = cx - sx / 2;
    const y0 = cy - sy / 2;
    const z0 = cz - sz / 2;
    this.rect([x0, y0 + sy, z0], [sx, 0, 0], [0, 0, sz], [0, 1, 0], coat);
    this.rect([x0, y0, z0], [0, sy, 0], [0, 0, sz], [-1, 0, 0], coat);
    this.rect([x0 + sx, y0, z0], [0, sy, 0], [0, 0, sz], [1, 0, 0], coat);
    this.rect([x0, y0, z0], [sx, 0, 0], [0, sy, 0], [0, 0, -1], coat);
    this.rect([x0, y0, z0 + sz], [sx, 0, 0], [0, sy, 0], [0, 0, 1], coat);
  }

  /** A cylinder centred on (cx, cy, cz), `h` long on `axis`, capped at both ends. */
  cylinder(cx: number, cy: number, cz: number, r: number, h: number, coat: Coat, axis: Axis = "y") {
    this.cone(cx, cy, cz, r, r, h, coat, axis);
  }

  /** A cylinder whose radius runs from `r0` at the low end to `r1` at the high end. */
  cone(
    cx: number,
    cy: number,
    cz: number,
    r0: number,
    r1: number,
    h: number,
    coat: Coat,
    axis: Axis = "y",
  ) {
    const step = this.spacing / this.scale;
    const rows = Math.max(1, Math.round(Math.hypot(h, r0 - r1) / step));
    const lean = Math.atan2(r0 - r1, h);
    const up = Math.sin(lean);
    const out = Math.cos(lean);

    for (let j = 0; j < rows; j += 1) {
      const k = (j + 0.5) / rows;
      const r = r0 + (r1 - r0) * k;
      const around = Math.max(3, Math.round((Math.PI * 2 * r) / step));
      const turn = this.random() * Math.PI * 2;

      for (let i = 0; i < around; i += 1) {
        const a = turn + (i / around) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        this.spun(axis, cx, cy, cz, ca * r, (k - 0.5) * h, sa * r, ca * out, up, sa * out, coat);
      }
    }

    this.cap(axis, cx, cy, cz, r0, -h / 2, -1, coat);
    this.cap(axis, cx, cy, cz, r1, h / 2, 1, coat);
  }

  /** A ball, or an egg when `squash` is not 1. */
  sphere(cx: number, cy: number, cz: number, r: number, coat: Coat, squash = 1) {
    const step = this.spacing / this.scale;
    const count = Math.max(6, Math.round((4 * Math.PI * r * r) / (step * step)));

    for (let i = 0; i < count; i += 1) {
      const y = 1 - (2 * (i + 0.5)) / count;
      const ring = Math.sqrt(1 - y * y);
      const a = i * GOLDEN;
      const nx = Math.cos(a) * ring;
      const nz = Math.sin(a) * ring;
      this.dab(cx + nx * r, cy + y * r * squash, cz + nz * r, nx, y, nz, coat);
    }
  }

  /** Half a hoop standing over the origin, spanning ±`span` on z: a gate to drive under. */
  arch(span: number, r: number, coat: Coat) {
    const step = this.spacing / this.scale;
    const along = Math.max(4, Math.round((Math.PI * span) / step));
    const around = Math.max(4, Math.round((Math.PI * 2 * r) / step));

    for (let i = 0; i < along; i += 1) {
      const phi = ((i + 0.5) / along) * Math.PI;
      const ry = Math.sin(phi);
      const rz = Math.cos(phi);

      for (let j = 0; j < around; j += 1) {
        const psi = ((j + this.random() * 0.5) / around) * Math.PI * 2;
        const c = Math.cos(psi);
        const nx = Math.sin(psi);
        this.dab(nx * r, ry * (span + c * r), rz * (span + c * r), nx, ry * c, rz * c, coat);
      }
    }
  }

  private cap(
    axis: Axis,
    cx: number,
    cy: number,
    cz: number,
    r: number,
    along: number,
    side: number,
    coat: Coat,
  ) {
    const step = this.spacing / this.scale;
    const count = Math.round((Math.PI * r * r) / (step * step));

    for (let i = 0; i < count; i += 1) {
      const d = r * Math.sqrt((i + 0.5) / count);
      const a = i * GOLDEN;
      this.spun(axis, cx, cy, cz, Math.cos(a) * d, along, Math.sin(a) * d, 0, side, 0, coat);
    }
  }

  private spun(
    axis: Axis,
    cx: number,
    cy: number,
    cz: number,
    a: number,
    b: number,
    c: number,
    na: number,
    nb: number,
    nc: number,
    coat: Coat,
  ) {
    if (axis === "x") {
      this.dab(cx + b, cy + a, cz + c, nb, na, nc, coat);
    } else if (axis === "z") {
      this.dab(cx + a, cy + c, cz + b, na, nc, nb, coat);
    } else {
      this.dab(cx + a, cy + b, cz + c, na, nb, nc, coat);
    }
  }
}
