import * as THREE from "three";

import { WORLD_H, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W } from "../shared/constants";

// Single reference scale for radially-symmetric features (hill Gaussians) so
// they stay circular in world space on the rectangular map.
const MAP_REF = (WORLD_W + WORLD_H) / 2;

// A hill in normalized map coords (u = west→east, v = north→south, both 0..1).
export type Hill = {
  readonly u: number;
  readonly v: number;
  readonly height: number;
  readonly radius: number;
};

// Land mask: 1 = solid inland, 0 = open water; smooth across the shoreline.
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
export type Flank = { height: number; slope: number; aspect: number };

/** Reusable Flank for per-vertex loops (the ground painter runs ~100k times). */
export function makeFlank(): Flank {
  return { height: 0, slope: 0, aspect: 0 };
}

const SHORE_DROP = 5; // how far the ground dips below sea level past the coast
const MARGIN = 24; // cached field extends past the map edge (camera, shoreline)
// World units between cached height samples. The field is bilinearly
// interpolated and the hills are broad Gaussians, so a 2u grid is visually
// indistinguishable from 1u while quartering the cache (O(area) on the big map).
const FIELD_STEP = 2;
const NORMAL_EPS = 1.6; // finite-difference step for surface normals

// Ground-mesh lattice. Shared by buildMesh and renderedHeightAt so the two can
// never drift — the whole point of the sampler is that it reports the mesh as
// DRAWN, which is only true while it mirrors the tessellation exactly.
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

// Orientation that keeps an object's facing along `yaw` (horizontal road/heading
// direction) while tilting its up-axis to the terrain normal — WITHOUT the
// incidental twist that setFromUnitVectors(UP, n) introduces on a slope.
export function slopeQuaternion(
  out: THREE.Quaternion,
  yaw: number,
  n: THREE.Vector3,
): THREE.Quaternion {
  scrFwd.set(Math.sin(yaw), 0, Math.cos(yaw));
  scrRight.crossVectors(n, scrFwd).normalize();
  scrRealFwd.crossVectors(scrRight, n).normalize();
  scrBasis.makeBasis(scrRight, n, scrRealFwd);
  return out.setFromRotationMatrix(scrBasis);
}

function worldToU(x: number): number {
  return x / WORLD_W + 0.5;
}
function worldToV(z: number): number {
  return z / WORLD_H + 0.5;
}

// One smooth, continuous SF height field shared by EVERYTHING — the ground
// mesh, the road geometry (subdivided + vertex-displaced through it), the car,
// traffic, fares and the camera. Because every consumer samples the same
// surface, roads meet the ground on the hills by construction; there is no
// per-tile tilting and therefore no seams. The raw field (island base +
// Gaussian hills) is cached on a fine grid so per-frame lookups stay cheap.
export class Terrain {
  private field: Float32Array; // ~map-area samples; Float32 halves the cache
  private nx: number; // cached samples east-west
  private nz: number; // cached samples north-south
  private minX: number; // world coordinate of sample 0 (x axis)
  private minZ: number; // world coordinate of sample 0 (z axis)

  constructor(
    private hills: readonly Hill[],
    private land: LandFactor,
  ) {
    this.minX = -WORLD_HALF_X - MARGIN;
    this.minZ = -WORLD_HALF_Z - MARGIN;
    this.nx = Math.ceil((WORLD_W + MARGIN * 2) / FIELD_STEP) + 1;
    this.nz = Math.ceil((WORLD_H + MARGIN * 2) / FIELD_STEP) + 1;
    this.field = new Float32Array(this.nx * this.nz);
    for (let ix = 0; ix < this.nx; ix++) {
      const x = this.minX + ix * FIELD_STEP;
      for (let iz = 0; iz < this.nz; iz++) {
        this.field[ix * this.nz + iz] = this.rawHeight(x, this.minZ + iz * FIELD_STEP);
      }
    }
  }

  // The raw continuous SF field: island base with a shoreline drop + hills.
  private rawHeight(x: number, z: number): number {
    const u = worldToU(x);
    const v = worldToV(z);
    const landAmt = this.land(u, v); // 0 water .. 1 inland
    const t = THREE.MathUtils.smoothstep(landAmt, 0.28, 0.42);
    let h = THREE.MathUtils.lerp(-SHORE_DROP, 0.3, t);
    for (const hl of this.hills) {
      const du = (u - hl.u) * WORLD_W;
      const dv = (v - hl.v) * WORLD_H;
      const r = hl.radius * MAP_REF;
      h += hl.height * t * Math.exp(-(du * du + dv * dv) / (r * r * 0.5));
    }
    return h;
  }

  private sample(ix: number, iz: number): number {
    const cx = Math.min(this.nx - 1, Math.max(0, ix));
    const cz = Math.min(this.nz - 1, Math.max(0, iz));
    return this.field[cx * this.nz + cz] ?? 0;
  }

  heightAt(x: number, z: number): number {
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

  // Surface normal via central differences over the smooth field.
  normalInto(out: THREE.Vector3, x: number, z: number): THREE.Vector3 {
    const e = NORMAL_EPS;
    const hl = this.heightAt(x - e, z);
    const hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e);
    const hu = this.heightAt(x, z + e);
    return out.set((hl - hr) / (2 * e), 1, (hd - hu) / (2 * e)).normalize();
  }

  landAt(x: number, z: number): number {
    return this.land(worldToU(x), worldToV(z));
  }

  // Height + grade + facing in one sample (see the Flank docs). The ground
  // painter bands hill flanks with this instead of re-deriving the field.
  flankInto(out: Flank, x: number, z: number): Flank {
    const e = NORMAL_EPS;
    const gx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const gz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    out.height = this.heightAt(x, z);
    out.slope = Math.hypot(gx, gz);
    // Downhill is -gradient; bearing 0 is -Z (north), turning clockwise.
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
  renderedHeightAt(x: number, z: number, offsetAt: (x: number, z: number) => number): number {
    const fx = (x + GROUND_SPAN_X / 2) / GROUND_STEP_X;
    const fz = (z + GROUND_SPAN_Z / 2) / GROUND_STEP_Z;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const at = (a: number, b: number): number => {
      const px = -GROUND_SPAN_X / 2 + a * GROUND_STEP_X;
      const pz = -GROUND_SPAN_Z / 2 + b * GROUND_STEP_Z;
      return this.heightAt(px, pz) + offsetAt(px, pz);
    };
    // PlaneGeometry splits each cell on the (i, j+1)–(i+1, j) diagonal.
    if (u + v <= 1) {
      const h = at(i, j);
      return h + u * (at(i + 1, j) - h) + v * (at(i, j + 1) - h);
    }
    const h = at(i + 1, j + 1);
    return h + (1 - u) * (at(i, j + 1) - h) + (1 - v) * (at(i + 1, j) - h);
  }

  // A displaced ground mesh covering the island (the ocean plane sits below
  // it). `colorAt` grades the surface per vertex (sand, park green, concrete) —
  // pair it with a vertexColors material. `offsetAt` shifts vertex height
  // (city.ts depresses the ground under road cells so this mesh's coarse
  // tessellation can never bow up through the finer draped asphalt).
  buildMesh(
    material: THREE.Material,
    colorAt?: (x: number, z: number, into: THREE.Color) => void,
    offsetAt?: (x: number, z: number) => number,
  ): THREE.Group {
    // TILED ground: one mesh per tile so three frustum-culls the terrain —
    // a single world-spanning mesh is always in frustum and always draws all
    // ~260k triangles. Tiles share edge vertices by construction (identical
    // sample positions), so there are no seams.
    const group = new THREE.Group();
    const c = new THREE.Color();
    for (let tx = 0; tx < GROUND_TILES_X; tx++) {
      for (let tz = 0; tz < GROUND_TILES_Z; tz++) {
        const w = GROUND_TILE_W;
        const d = GROUND_TILE_D;
        const cx = -GROUND_SPAN_X / 2 + (tx + 0.5) * w;
        const cz = -GROUND_SPAN_Z / 2 + (tz + 0.5) * d;
        const geo = new THREE.PlaneGeometry(w, d, GROUND_SEGS_X, GROUND_SEGS_Z);
        const pos = geo.attributes.position;
        if (pos instanceof THREE.BufferAttribute) {
          const colors = colorAt ? new Float32Array(pos.count * 3) : null;
          for (let i = 0; i < pos.count; i++) {
            const px = pos.getX(i) + cx;
            const py = pos.getY(i) - cz; // -90° X rotation: local +Y → world -Z
            pos.setZ(i, this.heightAt(px, -py) + (offsetAt ? offsetAt(px, -py) : 0));
            if (colors && colorAt) {
              colorAt(px, -py, c);
              colors[i * 3] = c.r;
              colors[i * 3 + 1] = c.g;
              colors[i * 3 + 2] = c.b;
            }
          }
          pos.needsUpdate = true;
          if (colors) geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
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
