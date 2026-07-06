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

const SHORE_DROP = 5; // how far the ground dips below sea level past the coast
const MARGIN = 24; // cached field extends past the map edge (camera, shoreline)
// World units between cached height samples. The field is bilinearly
// interpolated and the hills are broad Gaussians, so a 2u grid is visually
// indistinguishable from 1u while quartering the cache (O(area) on the big map).
const FIELD_STEP = 2;
const NORMAL_EPS = 1.6; // finite-difference step for surface normals

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
    const spanX = WORLD_W * 1.08;
    const spanZ = WORLD_H * 1.08;
    const TILES_X = 8;
    const TILES_Z = 6;
    const group = new THREE.Group();
    const c = new THREE.Color();
    for (let tx = 0; tx < TILES_X; tx++) {
      for (let tz = 0; tz < TILES_Z; tz++) {
        const w = spanX / TILES_X;
        const d = spanZ / TILES_Z;
        const cx = -spanX / 2 + (tx + 0.5) * w;
        const cz = -spanZ / 2 + (tz + 0.5) * d;
        const segs = Math.max(20, Math.round(w / 9));
        const segsZ2 = Math.max(20, Math.round(d / 9));
        const geo = new THREE.PlaneGeometry(w, d, segs, segsZ2);
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
