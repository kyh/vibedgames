import * as THREE from "three";

/** Picks a tone from a point in the solid's own space; a negative keeps the coat's. */
export type ToneAt = (x: number, y: number, z: number) => number;

export interface Coat {
  tone: number;
  flags?: number;
  at?: ToneAt;
}

export const FLAG = {
  flat: 64,
  floor: 2,
  noOutline: 16,
  noShadow: 4,
  pulse: 8,
  soft: 32,
  unlit: 1,
} as const;

/** A ramp id that means "read this face's tone from the board texture". */
export const TEXTURED = 255;

type Axis = "x" | "y" | "z";

type Vec = readonly [number, number, number];

const STEPS = 8;
const ORIGIN: Vec = [0, 0, 0];

const gap = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const mix = (a: Vec, b: Vec, t: number) =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] as const;

export class MeshBuilder {
  /** World units across one cell of a patterned face. */
  readonly detail: number;
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly tones: number[] = [];
  private tx = 0;
  private ty = 0;
  private tz = 0;
  private cos = 1;
  private sin = 0;
  private scale = 1;
  private id = 1;

  constructor(detail = 0.1) {
    this.detail = detail;
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

  /** Start a new part: the outline pass draws a line where two parts meet. */
  part() {
    this.id = (this.id % 250) + 1;

    return this;
  }

  /** A parallelogram from `o` along `u` and `v`, facing `n`. */
  quad(o: Vec, u: Vec, v: Vec, n: Vec, coat: Coat) {
    this.patch(
      o,
      [o[0] + u[0], o[1] + u[1], o[2] + u[2]],
      [o[0] + u[0] + v[0], o[1] + u[1] + v[1], o[2] + u[2] + v[2]],
      [o[0] + v[0], o[1] + v[1], o[2] + v[2]],
      n,
      coat,
    );
  }

  /** Any flat four-cornered face, corners in order round its edge. A patterned coat is cut into cells. */
  patch(a: Vec, b: Vec, c: Vec, d: Vec, n: Vec, coat: Coat) {
    const { at } = coat;
    const flags = coat.flags ?? 0;

    if (!at) {
      this.fan(ORIGIN, [a, b, c, d], [n, n, n, n], coat.tone, flags);

      return;
    }

    const nu = Math.max(1, Math.round(Math.max(gap(a, b), gap(d, c)) / this.detail));
    const nv = Math.max(1, Math.round(Math.max(gap(a, d), gap(b, c)) / this.detail));

    const spot = (s: number, t: number) => {
      const low = mix(a, b, s);
      const high = mix(d, c, s);

      return mix(low, high, t);
    };

    for (let i = 0; i < nu; i += 1) {
      for (let j = 0; j < nv; j += 1) {
        const middle = spot((i + 0.5) / nu, (j + 0.5) / nv);
        const picked = at(middle[0], middle[1], middle[2]);
        this.fan(
          ORIGIN,
          [
            spot(i / nu, j / nv),
            spot((i + 1) / nu, j / nv),
            spot((i + 1) / nu, (j + 1) / nv),
            spot(i / nu, (j + 1) / nv),
          ],
          [n, n, n, n],
          picked < 0 ? coat.tone : picked,
          flags,
        );
      }
    }
  }

  /** A box centred on (cx, cy, cz). The underside is left open: nothing ever sees it. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, coat: Coat) {
    this.taper(cx, cy, cz, sx, sy, sz, 0, 0, coat);
  }

  /**
   * A box whose top is pulled in by `inX` at each end and `inZ` at each side:
   * a cab, a wedge, a plinth.
   */
  taper(
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    inX: number,
    inZ: number,
    coat: Coat,
  ) {
    const x0 = cx - sx / 2;
    const x1 = cx + sx / 2;
    const y0 = cy - sy / 2;
    const y1 = cy + sy / 2;
    const z0 = cz - sz / 2;
    const z1 = cz + sz / 2;
    const leanX = Math.hypot(sy, inX) || 1;
    const leanZ = Math.hypot(sy, inZ) || 1;
    this.quad(
      [x0 + inX, y1, z0 + inZ],
      [0, 0, sz - inZ * 2],
      [sx - inX * 2, 0, 0],
      [0, 1, 0],
      coat,
    );
    this.patch(
      [x0, y0, z1],
      [x0, y0, z0],
      [x0 + inX, y1, z0 + inZ],
      [x0 + inX, y1, z1 - inZ],
      [-sy / leanX, inX / leanX, 0],
      coat,
    );
    this.patch(
      [x1, y0, z0],
      [x1, y0, z1],
      [x1 - inX, y1, z1 - inZ],
      [x1 - inX, y1, z0 + inZ],
      [sy / leanX, inX / leanX, 0],
      coat,
    );
    this.patch(
      [x0, y0, z0],
      [x1, y0, z0],
      [x1 - inX, y1, z0 + inZ],
      [x0 + inX, y1, z0 + inZ],
      [0, inZ / leanZ, -sy / leanZ],
      coat,
    );
    this.patch(
      [x1, y0, z1],
      [x0, y0, z1],
      [x0 + inX, y1, z1 - inZ],
      [x1 - inX, y1, z1 - inZ],
      [0, inZ / leanZ, sy / leanZ],
      coat,
    );
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
    const sides = Math.max(8, Math.min(24, Math.round((Math.max(r0, r1) * 6) / this.detail / 4)));
    const lean = Math.atan2(r0 - r1, h);
    const up = Math.sin(lean);
    const out = Math.cos(lean);

    const spin = (a: number, b: number, c: number) => {
      if (axis === "x") {
        return [b, a, c] as const;
      }

      return axis === "z" ? ([a, c, b] as const) : ([a, b, c] as const);
    };

    const flip = axis === "y";
    const flags = coat.flags ?? 0;

    for (let i = 0; i < sides; i += 1) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      const low0 = spin(c0 * r0, -h / 2, s0 * r0);
      const low1 = spin(c1 * r0, -h / 2, s1 * r0);
      const high0 = spin(c0 * r1, h / 2, s0 * r1);
      const high1 = spin(c1 * r1, h / 2, s1 * r1);
      const n0 = spin(c0 * out, up, s0 * out);
      const n1 = spin(c1 * out, up, s1 * out);
      const centre: Vec = [cx, cy, cz];

      const picked = coat.at
        ? coat.at(
            cx + (low0[0] + high1[0]) / 2,
            cy + (low0[1] + high1[1]) / 2,
            cz + (low0[2] + high1[2]) / 2,
          )
        : -1;

      const side = picked < 0 ? coat.tone : picked;
      const ring = flip ? [low0, high0, high1, low1] : [low0, low1, high1, high0];
      const ringN = flip ? [n0, n0, n1, n1] : [n0, n1, n1, n0];
      this.fan(centre, ring, ringN, side, flags);
      const top = spin(0, h / 2, 0);
      const bottom = spin(0, -h / 2, 0);
      const upN = spin(0, 1, 0);
      const downN = spin(0, -1, 0);
      this.fan(
        centre,
        flip ? [top, high1, high0] : [top, high0, high1],
        [upN, upN, upN],
        coat.tone,
        flags,
      );
      this.fan(
        centre,
        flip ? [bottom, low0, low1] : [bottom, low1, low0],
        [downN, downN, downN],
        coat.tone,
        flags,
      );
    }
  }

  /** A ball, or an egg when `squash` is not 1. */
  sphere(cx: number, cy: number, cz: number, r: number, coat: Coat, squash = 1) {
    const around = Math.max(8, Math.min(20, Math.round((r * 6) / this.detail / 4)));
    const down = Math.max(4, Math.round(around / 2));
    const flags = coat.flags ?? 0;

    const spot = (i: number, j: number) => {
      const phi = (j / down) * Math.PI;
      const theta = (i / around) * Math.PI * 2;

      return [
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      ] as const;
    };

    for (let j = 0; j < down; j += 1) {
      for (let i = 0; i < around; i += 1) {
        const corners = [spot(i, j), spot(i + 1, j), spot(i + 1, j + 1), spot(i, j + 1)];
        this.fan(
          [cx, cy, cz],
          corners.map((n) => [n[0] * r, n[1] * r * squash, n[2] * r] as const),
          corners,
          coat.tone,
          flags,
        );
      }
    }
  }

  /** The finished solid. */
  build() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute("aTone", new THREE.Uint8BufferAttribute(this.tones, 4));
    geometry.computeBoundingSphere();

    return geometry;
  }

  private fan(
    origin: Vec,
    corners: readonly Vec[],
    normals: readonly Vec[],
    tone: number,
    flags: number,
  ) {
    for (let i = 1; i < corners.length - 1; i += 1) {
      for (const k of [0, i, i + 1]) {
        const p = corners[k] ?? [0, 0, 0];
        const n = normals[k] ?? [0, 1, 0];
        this.vertex(origin[0] + p[0], origin[1] + p[1], origin[2] + p[2], n, tone, flags);
      }
    }
  }

  private vertex(x: number, y: number, z: number, n: Vec, tone: number, flags: number) {
    const { cos, scale, sin } = this;
    this.positions.push(
      this.tx + (cos * x - sin * z) * scale,
      this.ty + y * scale,
      this.tz + (sin * x + cos * z) * scale,
    );
    this.normals.push(cos * n[0] - sin * n[2], n[1], sin * n[0] + cos * n[2]);
    this.tones.push(Math.floor(tone / STEPS), tone % STEPS, flags, this.id);
  }
}
