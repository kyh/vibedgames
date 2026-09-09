// oxlint-disable-next-line max-classes-per-file -- one buffer family: the base and the two subclasses that add facade and sign attributes
import { SIGN_COLUMNS, SIGN_CROP_END, SIGN_CROP_START, SIGN_ROWS } from "./parcel-signs";

// The merged, vertex-coloured buffers the parcel fabric is written into:
// positions, packed normals, bytes of colour, and — for the facade shader and
// the shop lettering — their extra per-vertex attributes.

/**
 * Ear-clipping triangulation of a simple xz ring (positive signed area).
 * Rings here are 4-60 vertices, so the O(n²) walk is nothing, and it keeps
 * this module free of three — the harness triangulates the same roofs in
 * node to count the budget.
 */
const earClip = (ring: Float32Array, n: number): number[] => {
  const tris: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i += 1) {
    idx.push(i);
  }
  const px = (i: number): number => ring[i * 2] ?? 0;
  const pz = (i: number): number => ring[i * 2 + 1] ?? 0;
  const turn = (a: number, b: number, c: number): number =>
    (px(b) - px(a)) * (pz(c) - pz(a)) - (pz(b) - pz(a)) * (px(c) - px(a));
  const inside = (a: number, b: number, c: number, p: number): boolean =>
    turn(a, b, p) >= 0 && turn(b, c, p) >= 0 && turn(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard < 4 * n) {
    guard += 1;
    let clipped = false;
    for (let k = 0; k < idx.length; k += 1) {
      const a = idx[(k + idx.length - 1) % idx.length] ?? 0;
      const b = idx[k] ?? 0;
      const c = idx[(k + 1) % idx.length] ?? 0;
      // reflex or degenerate
      if (turn(a, b, c) <= 1e-9) {
        continue;
      }
      let ear = true;
      for (const p of idx) {
        if (p === a || p === b || p === c) {
          continue;
        }
        if (inside(a, b, c, p)) {
          ear = false;
          break;
        }
      }
      if (!ear) {
        continue;
      }
      tris.push(a, b, c);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    // not simple after all: leave what we have
    if (!clipped) {
      break;
    }
  }
  if (idx.length === 3) {
    tris.push(idx[0] ?? 0, idx[1] ?? 0, idx[2] ?? 0);
  }
  return tris;
};

export class GeoBuf {
  pos = new Float32Array(3 * 1024);
  nor = new Int8Array(3 * 1024);
  col = new Uint8Array(3 * 1024);
  idx = new Uint32Array(6 * 1024);
  nv = 0;
  ni = 0;

  protected reserve(verts: number, indices: number): void {
    if ((this.nv + verts) * 3 > this.pos.length) {
      const cap = Math.max(this.pos.length * 2, (this.nv + verts) * 3);
      const p = new Float32Array(cap);
      p.set(this.pos);
      this.pos = p;
      const n = new Int8Array(cap);
      n.set(this.nor);
      this.nor = n;
      const c = new Uint8Array(cap);
      c.set(this.col);
      this.col = c;
    }
    if (this.ni + indices > this.idx.length) {
      const i = new Uint32Array(Math.max(this.idx.length * 2, this.ni + indices));
      i.set(this.idx);
      this.idx = i;
    }
  }

  protected vert(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    c: number,
  ): void {
    const o = this.nv * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.nor[o] = Math.round(nx * 127);
    this.nor[o + 1] = Math.round(ny * 127);
    this.nor[o + 2] = Math.round(nz * 127);
    this.col[o] = Math.floor(c / 0x1_00_00) % 256;
    this.col[o + 1] = Math.floor(c / 0x1_00) % 256;
    this.col[o + 2] = c % 256;
    this.nv += 1;
  }

  /**
   * A quad a-b-c-d, wound so its face normal agrees with (nx, ny, nz) —
   * the caller hands over the OUTWARD direction and never thinks about winding.
   */
  quad(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
    nx: number,
    ny: number,
    nz: number,
    color: number,
  ): void {
    this.reserve(4, 6);
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    const len = Math.hypot(fx, fy, fz) || 1;
    let onx = fx / len;
    let ony = fy / len;
    let onz = fz / len;
    const flip = onx * nx + ony * ny + onz * nz < 0;
    if (flip) {
      onx = -onx;
      ony = -ony;
      onz = -onz;
    }
    const base = this.nv;
    this.vert(ax, ay, az, onx, ony, onz, color);
    this.vert(bx, by, bz, onx, ony, onz, color);
    this.vert(cx, cy, cz, onx, ony, onz, color);
    this.vert(dx, dy, dz, onx, ony, onz, color);
    const i = this.ni;
    this.idx[i] = base;
    if (flip) {
      this.idx[i + 1] = base + 2;
      this.idx[i + 2] = base + 1;
      this.idx[i + 3] = base;
      this.idx[i + 4] = base + 3;
      this.idx[i + 5] = base + 2;
    } else {
      this.idx[i + 1] = base + 1;
      this.idx[i + 2] = base + 2;
      this.idx[i + 3] = base;
      this.idx[i + 4] = base + 2;
      this.idx[i + 5] = base + 3;
    }
    this.ni += 6;
  }

  triangle(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    nx: number,
    ny: number,
    nz: number,
    color: number,
  ): void {
    this.reserve(3, 3);
    const base = this.nv;
    const flip =
      ((by - ay) * (cz - az) - (bz - az) * (cy - ay)) * nx +
        ((bz - az) * (cx - ax) - (bx - ax) * (cz - az)) * ny +
        ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) * nz <
      0;
    this.vert(ax, ay, az, nx, ny, nz, color);
    this.vert(bx, by, bz, nx, ny, nz, color);
    this.vert(cx, cy, cz, nx, ny, nz, color);
    this.idx[this.ni] = base;
    this.idx[this.ni + 1] = base + (flip ? 2 : 1);
    this.idx[this.ni + 2] = base + (flip ? 1 : 2);
    this.ni += 3;
  }

  /** A polygon draped on per-vertex heights, facing up — the surface lots. */
  capDraped(ring: Float32Array, n: number, ys: Float32Array, lift: number, color: number): void {
    const tris = earClip(ring, n);
    this.reserve(n, tris.length);
    const base = this.nv;
    for (let i = 0; i < n; i += 1) {
      this.vert(ring[i * 2] ?? 0, (ys[i] ?? 0) + lift, ring[i * 2 + 1] ?? 0, 0, 1, 0, color);
    }
    for (let t = 0; t < tris.length; t += 3) {
      const i = this.ni;
      this.idx[i] = base + (tris[t] ?? 0);
      this.idx[i + 1] = base + (tris[t + 2] ?? 0);
      this.idx[i + 2] = base + (tris[t + 1] ?? 0);
      this.ni += 3;
    }
  }

  /** A horizontal polygon (positive-area xz ring at height y) facing up (+1) or down (-1). */
  cap(ring: Float32Array, n: number, y: number, up: 1 | -1, color: number): void {
    const tris = earClip(ring, n);
    this.reserve(n, tris.length);
    const base = this.nv;
    for (let i = 0; i < n; i += 1) {
      this.vert(ring[i * 2] ?? 0, y, ring[i * 2 + 1] ?? 0, 0, up, 0, color);
    }
    // Ears come out with a positive (x,z) turn, which with y up faces DOWN.
    for (let t = 0; t < tris.length; t += 3) {
      const i = this.ni;
      this.idx[i] = base + (tris[t] ?? 0);
      if (up === 1) {
        this.idx[i + 1] = base + (tris[t + 2] ?? 0);
        this.idx[i + 2] = base + (tris[t + 1] ?? 0);
      } else {
        this.idx[i + 1] = base + (tris[t + 1] ?? 0);
        this.idx[i + 2] = base + (tris[t + 2] ?? 0);
      }
      this.ni += 3;
    }
  }
}

/**
 * Walls the FACADE SHADER dresses (the lean, non-survey fabric): every vertex
 * also carries its along-wall / above-seat coordinate and the wall's storey
 * rhythm, and the shader draws the windows, doors and shopfronts from those.
 * Zero extra geometry per opening — which is the only way 130k parcels fit.
 *
 * facade (u16 ×4, normalized, ×FACADE_SCALE): storeyH, pitch, groundH, wallLen
 * facade2 (u8 ×3, raw): storeys, seed, flags
 */
export const FACADE_SCALE = 512;
/** Metres the v coordinate is lifted by so a foundation band below the seat stays unsigned. */
export const FUV_V_BIAS = 8;
export const FACADE_FLAG_SHOP = 1;
export const FACADE_FLAG_HOUSE = 2;
export const FACADE_FLAG_SHED = 4;
export const FACADE_FLAG_BLANK = 8;
export const FACADE_FLAG_BRICK = 16;
export const FACADE_FLAG_SIDING = 32;

export interface FacadeParams {
  readonly storeyH: number;
  readonly pitch: number;
  readonly groundH: number;
  readonly wallLen: number;
  readonly storeys: number;
  readonly seed: number;
  readonly flags: number;
}

export class FacadeBuf extends GeoBuf {
  fuv = new Uint16Array(2 * 1024);
  fac = new Uint16Array(4 * 1024);
  fac2 = new Uint8Array(3 * 1024);

  protected override reserve(verts: number, indices: number): void {
    super.reserve(verts, indices);
    const cap = this.pos.length / 3;
    if (cap * 2 > this.fuv.length) {
      const u = new Uint16Array(cap * 2);
      u.set(this.fuv);
      this.fuv = u;
      const f = new Uint16Array(cap * 4);
      f.set(this.fac);
      this.fac = f;
      const g = new Uint8Array(cap * 3);
      g.set(this.fac2);
      this.fac2 = g;
    }
  }

  /** A wall quad from (x0, z0) along (tx, tz) for len, seat y0 to top y1, with its facade data. */
  wall(
    x0: number,
    z0: number,
    tx: number,
    tz: number,
    len: number,
    y0: number,
    y1: number,
    nx: number,
    nz: number,
    color: number,
    fp: FacadeParams,
    vBase: number,
  ): void {
    const base = this.nv;
    const x1 = x0 + tx * len;
    const z1 = z0 + tz * len;
    this.quad(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0, nx, 0, nz, color);
    const q = (v: number): number =>
      Math.max(0, Math.min(65_535, Math.round((v / FACADE_SCALE) * 65_535)));
    const us = [0, len, len, 0];
    const vs = [vBase, vBase, vBase + (y1 - y0), vBase + (y1 - y0)];
    for (let k = 0; k < 4; k += 1) {
      const i = base + k;
      // Centimetres, unsigned: v is measured from the seat and the foundation
      // band dips below it, so the shader subtracts FUV_V_BIAS back out.
      this.fuv[i * 2] = Math.max(0, Math.min(65_535, Math.round((us[k] ?? 0) * 100)));
      this.fuv[i * 2 + 1] = Math.max(
        0,
        Math.min(65_535, Math.round(((vs[k] ?? 0) + FUV_V_BIAS) * 100)),
      );
      this.fac[i * 4] = q(fp.storeyH);
      this.fac[i * 4 + 1] = q(fp.pitch);
      this.fac[i * 4 + 2] = q(fp.groundH);
      this.fac[i * 4 + 3] = q(fp.wallLen);
      this.fac2[i * 3] = Math.min(255, fp.storeys);
      this.fac2[i * 3 + 1] = fp.seed % 256;
      this.fac2[i * 3 + 2] = fp.flags % 256;
    }
  }
}

export class SignBuf extends GeoBuf {
  readonly coordinates: number[] = [];

  /** Atlas inset keeps filtering inside a label's transparent gutter. */
  label(index: number): void {
    const column = index % SIGN_COLUMNS;
    const row = Math.floor(index / SIGN_COLUMNS);
    const u0 = column / SIGN_COLUMNS;
    const u1 = (column + 1) / SIGN_COLUMNS;
    const v0 = 1 - (row + SIGN_CROP_END) / SIGN_ROWS;
    const v1 = 1 - (row + SIGN_CROP_START) / SIGN_ROWS;
    // Positive-area parcel walls run right-to-left when viewed from the street.
    this.coordinates.push(u1, v0, u0, v0, u0, v1, u1, v1);
  }
}
