import * as THREE from "three";

import { WORLD_H, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W } from "../shared/constants";

const MAP_REF = (WORLD_W + WORLD_H) / 2;

export interface Hill {
  readonly u: number;
  readonly v: number;
  readonly height: number;
  readonly radius: number;
}

export type LandFactor = (u: number, v: number) => number;

/**
 * The three things a flank can be graded by, sampled together because they all
 * come from one pair of central differences. `height` is metres-free world
 * units above sea level (negative offshore); `slope` is rise/run, so 0.3 is a
 * 30% grade and SF's steep streets sit near 0.5 after the map's ~2× vertical
 * exaggeration; `aspect` is the compass bearing the flank FACES (downhill),
 * radians clockwise from north (-Z), and is 0 wherever slope is ~0 because a
 * flat cell has no aspect. Sampled off the analytic field, not the drawn ground
 * mesh: banding wants the smooth shape, not the ~9u lattice's facets.
 */
export interface Flank {
  height: number;
  slope: number;
  aspect: number;
}

/** A visible surface the tessellated ground must remain below. */
export interface GroundCeiling {
  readonly x: number;
  readonly z: number;
  readonly y: number;
}

/** Reusable Flank for per-vertex loops (the ground painter runs ~100k times). */
export const makeFlank = () => ({ aspect: 0, height: 0, slope: 0 });

const SHORE_DROP = 5;
const MARGIN = 132;
const FIELD_STEP = 2;
const NORMAL_EPS = 1.6;

const GROUND_SPAN_X = WORLD_W * 1.08;
const GROUND_SPAN_Z = WORLD_H * 1.08;
const GROUND_TILES_X = 8;
const GROUND_TILES_Z = 6;
const GROUND_TILE_W = GROUND_SPAN_X / GROUND_TILES_X;
const GROUND_TILE_D = GROUND_SPAN_Z / GROUND_TILES_Z;
const GROUND_SEGS_X = Math.max(20, Math.round(GROUND_TILE_W / 9));
const GROUND_SEGS_Z = Math.max(20, Math.round(GROUND_TILE_D / 9));
const GROUND_STEP_X = GROUND_TILE_W / GROUND_SEGS_X;
const GROUND_STEP_Z = GROUND_TILE_D / GROUND_SEGS_Z;

const scrFwd = new THREE.Vector3();
const scrRight = new THREE.Vector3();
const scrRealFwd = new THREE.Vector3();
const scrBasis = new THREE.Matrix4();

export const slopeQuaternion = (out: THREE.Quaternion, yaw: number, n: THREE.Vector3) => {
  scrFwd.set(Math.sin(yaw), 0, Math.cos(yaw));
  scrRight.crossVectors(n, scrFwd).normalize();
  scrRealFwd.crossVectors(scrRight, n).normalize();
  scrBasis.makeBasis(scrRight, n, scrRealFwd);

  return out.setFromRotationMatrix(scrBasis);
};

const worldToU = (x: number) => x / WORLD_W + 0.5;
const worldToV = (z: number) => z / WORLD_H + 0.5;

export class Terrain {
  private readonly field: Float32Array;
  private readonly nx: number;
  private readonly nz: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly hillTable: readonly {
    readonly x: number;
    readonly z: number;
    readonly height: number;
    readonly invDen: number;
    readonly cull2: number;
  }[];

  private readonly hills: readonly Hill[];
  private readonly land: LandFactor;
  private readonly heightPatch?: (x: number, z: number, height: number) => number;

  constructor(
    hills: readonly Hill[],
    land: LandFactor,
    heightPatch?: (x: number, z: number, height: number) => number,
  ) {
    this.hills = hills;
    this.land = land;
    this.heightPatch = heightPatch;
    this.minX = -WORLD_HALF_X - MARGIN;
    this.minZ = -WORLD_HALF_Z - MARGIN;
    this.nx = Math.ceil((WORLD_W + MARGIN * 2) / FIELD_STEP) + 1;
    this.nz = Math.ceil((WORLD_H + MARGIN * 2) / FIELD_STEP) + 1;
    this.field = new Float32Array(this.nx * this.nz);
    this.hillTable = hills.map((hl) => {
      const r = hl.radius * MAP_REF;
      const den = r * r * 0.5;

      return {
        cull2: den * 21,
        height: hl.height,
        invDen: 1 / den,
        x: (hl.u - 0.5) * WORLD_W - this.minX,
        z: (hl.v - 0.5) * WORLD_H - this.minZ,
      };
    });

    for (let ix = 0; ix < this.nx; ix += 1) {
      const x = this.minX + ix * FIELD_STEP;

      for (let iz = 0; iz < this.nz; iz += 1) {
        this.field[ix * this.nz + iz] = this.rawHeight(x, this.minZ + iz * FIELD_STEP);
      }
    }
  }

  private rawHeight(x: number, z: number) {
    const u = worldToU(x);
    const v = worldToV(z);
    const landAmt = this.land(u, v);
    const t = THREE.MathUtils.smoothstep(landAmt, 0.28, 0.42);
    let h = THREE.MathUtils.lerp(-SHORE_DROP, 0.3, t);
    const x0 = x - this.minX;
    const z0 = z - this.minZ;

    for (const hl of this.hillTable) {
      const du = x0 - hl.x;
      const dv = z0 - hl.z;
      const d2 = du * du + dv * dv;

      if (d2 > hl.cull2) {
        continue;
      }

      h += hl.height * t * Math.exp(-d2 * hl.invDen);
    }

    return this.heightPatch ? this.heightPatch(x, z, h) : h;
  }

  private sample(ix: number, iz: number) {
    const cx = Math.min(this.nx - 1, Math.max(0, ix));
    const cz = Math.min(this.nz - 1, Math.max(0, iz));

    return this.field[cx * this.nz + cz] ?? 0;
  }

  heightAt(x: number, z: number) {
    const fx = (x - this.minX) / FIELD_STEP;
    const fz = (z - this.minZ) / FIELD_STEP;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const h00 = this.sample(ix, iz);
    const h10 = this.sample(ix + 1, iz);
    const h01 = this.sample(ix, iz + 1);
    const h11 = this.sample(ix + 1, iz + 1);
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;

    return a + (b - a) * tz;
  }

  normalInto(out: THREE.Vector3, x: number, z: number) {
    const e = NORMAL_EPS;
    const hl = this.heightAt(x - e, z);
    const hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e);
    const hu = this.heightAt(x, z + e);

    return out.set((hl - hr) / (2 * e), 1, (hd - hu) / (2 * e)).normalize();
  }

  landAt(x: number, z: number) {
    return this.land(worldToU(x), worldToV(z));
  }

  flankInto(out: Flank, x: number, z: number) {
    const e = NORMAL_EPS;
    const gx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const gz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    out.height = this.heightAt(x, z);
    out.slope = Math.hypot(gx, gz);
    out.aspect = out.slope < 1e-4 ? 0 : Math.atan2(-gx, gz);

    return out;
  }

  /**
   * Height of the ground mesh AS DRAWN. buildMesh only evaluates the field on
   * its ~9u lattice and renders flat triangles between the samples, so the
   * analytic height is NOT what you see beside a kerb: the street depression
   * (ground.ts) is a ~3u trench and the street terrace is a 3.25u step — both
   * narrower than one lattice cell, so the mesh smears them. Seat lawn props
   * on this; heightAt (and the analytic drive surface) float above the grass.
   */
  renderedHeightAt(x: number, z: number, offsetAt: (x: number, z: number) => number) {
    const fx = (x + GROUND_SPAN_X / 2) / GROUND_STEP_X;
    const fz = (z + GROUND_SPAN_Z / 2) / GROUND_STEP_Z;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;

    const at = (a: number, b: number) => {
      const px = -GROUND_SPAN_X / 2 + a * GROUND_STEP_X;
      const pz = -GROUND_SPAN_Z / 2 + b * GROUND_STEP_Z;

      return this.heightAt(px, pz) + offsetAt(px, pz);
    };

    if (u + v <= 1) {
      const h = at(i, j);

      return h + u * (at(i + 1, j) - h) + v * (at(i, j + 1) - h);
    }

    const h = at(i + 1, j + 1);

    return h + (1 - u) * (at(i, j + 1) - h) + (1 - v) * (at(i + 1, j) - h);
  }

  /**
   * Lower the ground's actual triangle vertices only where a road pierces it.
   * Each ceiling lowers all three supporting corners by the same excess, so
   * later samples cannot undo earlier clearance. This uses the buildMesh
   * lattice, not a second approximate terrain field; standing props query the
   * returned offset through renderedHeightAt and see the same correction.
   */
  capGroundOffset(offsetAt: (x: number, z: number) => number, ceilings: Iterable<GroundCeiling>) {
    const width = GROUND_TILES_X * GROUND_SEGS_X + 1;
    const depth = GROUND_TILES_Z * GROUND_SEGS_Z + 1;
    const heights = new Float32Array(width * depth).fill(Number.NaN);
    const lower = new Float32Array(width * depth);
    const key = (i: number, j: number) => i * depth + j;

    const height = (i: number, j: number) => {
      const k = key(i, j);
      const cached = heights[k];

      if (cached !== undefined && Number.isFinite(cached)) {
        return cached;
      }

      const x = -GROUND_SPAN_X / 2 + i * GROUND_STEP_X;
      const z = -GROUND_SPAN_Z / 2 + j * GROUND_STEP_Z;
      const y = this.heightAt(x, z) + offsetAt(x, z);
      heights[k] = y;

      return y;
    };

    for (const p of ceilings) {
      const fx = (p.x + GROUND_SPAN_X / 2) / GROUND_STEP_X;
      const fz = (p.z + GROUND_SPAN_Z / 2) / GROUND_STEP_Z;
      const i = Math.floor(fx);
      const j = Math.floor(fz);

      if (i < 0 || j < 0 || i >= width - 1 || j >= depth - 1) {
        continue;
      }

      const u = fx - i;
      const v = fz - j;
      const near = u + v <= 1;
      const a = near ? key(i, j) : key(i + 1, j + 1);
      const b = key(i + 1, j);
      const c = key(i, j + 1);
      const h = near ? height(i, j) : height(i + 1, j + 1);

      const y = near
        ? h + u * (height(i + 1, j) - h) + v * (height(i, j + 1) - h)
        : h + (1 - u) * (height(i, j + 1) - h) + (1 - v) * (height(i + 1, j) - h);

      const excess = y - p.y;

      if (excess <= 0) {
        continue;
      }

      for (const k of [a, b, c]) {
        lower[k] = Math.max(lower[k] ?? 0, excess);
      }
    }

    return ((x, z) => {
      const fx = (x + GROUND_SPAN_X / 2) / GROUND_STEP_X;
      const fz = (z + GROUND_SPAN_Z / 2) / GROUND_STEP_Z;
      const i = Math.floor(fx);
      const j = Math.floor(fz);

      if (i < 0 || j < 0 || i >= width - 1 || j >= depth - 1) {
        return offsetAt(x, z);
      }

      const u = fx - i;
      const v = fz - j;
      const a = lower[key(i, j)] ?? 0;
      const b = lower[key(i + 1, j)] ?? 0;
      const c = lower[key(i, j + 1)] ?? 0;
      const d = lower[key(i + 1, j + 1)] ?? 0;

      return offsetAt(x, z) - ((a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v);
    }) satisfies (x: number, z: number) => number;
  }

  buildMesh(
    material: THREE.Material,
    colorAt?: (x: number, z: number, into: THREE.Color) => void,
    offsetAt?: (x: number, z: number) => number,
  ) {
    const group = new THREE.Group();
    const c = new THREE.Color();

    for (let tx = 0; tx < GROUND_TILES_X; tx += 1) {
      for (let tz = 0; tz < GROUND_TILES_Z; tz += 1) {
        const w = GROUND_TILE_W;
        const d = GROUND_TILE_D;
        const cx = -GROUND_SPAN_X / 2 + (tx + 0.5) * w;
        const cz = -GROUND_SPAN_Z / 2 + (tz + 0.5) * d;
        const geo = new THREE.PlaneGeometry(w, d, GROUND_SEGS_X, GROUND_SEGS_Z);
        const pos = geo.attributes.position;

        if (pos instanceof THREE.BufferAttribute) {
          const colors = colorAt ? new Float32Array(pos.count * 3) : null;

          for (let i = 0; i < pos.count; i += 1) {
            const px = pos.getX(i) + cx;
            const py = pos.getY(i) - cz;
            pos.setZ(i, this.heightAt(px, -py) + (offsetAt ? offsetAt(px, -py) : 0));

            if (colors && colorAt) {
              colorAt(px, -py, c);
              colors[i * 3] = c.r;
              colors[i * 3 + 1] = c.g;
              colors[i * 3 + 2] = c.b;
            }
          }

          pos.needsUpdate = true;

          if (colors) {
            geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
          }
        }

        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, material);
        mesh.position.set(cx, 0, cz);
        mesh.rotation.x = -Math.PI / 2;
        mesh.receiveShadow = true;
        mesh.name = "terrain-ground";
        group.add(mesh);
      }
    }

    return group;
  }
}
