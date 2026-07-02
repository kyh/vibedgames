import * as THREE from "three";

import { WORLD_HALF, WORLD_SIZE } from "../shared/constants";

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
const FIELD_STEP = 1; // world units between cached height samples
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
  return x / WORLD_SIZE + 0.5;
}
function worldToV(z: number): number {
  return z / WORLD_SIZE + 0.5;
}

// One smooth, continuous SF height field shared by EVERYTHING — the ground
// mesh, the road geometry (subdivided + vertex-displaced through it), the car,
// traffic, fares and the camera. Because every consumer samples the same
// surface, roads meet the ground on the hills by construction; there is no
// per-tile tilting and therefore no seams. The raw field (island base +
// Gaussian hills) is cached on a fine grid so per-frame lookups stay cheap.
export class Terrain {
  private field: Float64Array;
  private n: number; // cached samples per side
  private min: number; // world coordinate of sample 0 (both axes)

  constructor(
    private hills: readonly Hill[],
    private land: LandFactor,
  ) {
    this.min = -WORLD_HALF - MARGIN;
    this.n = Math.ceil((WORLD_SIZE + MARGIN * 2) / FIELD_STEP) + 1;
    this.field = new Float64Array(this.n * this.n);
    for (let ix = 0; ix < this.n; ix++) {
      const x = this.min + ix * FIELD_STEP;
      for (let iz = 0; iz < this.n; iz++) {
        this.field[ix * this.n + iz] = this.rawHeight(x, this.min + iz * FIELD_STEP);
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
      const du = (u - hl.u) * WORLD_SIZE;
      const dv = (v - hl.v) * WORLD_SIZE;
      const r = hl.radius * WORLD_SIZE;
      h += hl.height * t * Math.exp(-(du * du + dv * dv) / (r * r * 0.5));
    }
    return h;
  }

  private sample(ix: number, iz: number): number {
    const cx = Math.min(this.n - 1, Math.max(0, ix));
    const cz = Math.min(this.n - 1, Math.max(0, iz));
    return this.field[cx * this.n + cz] ?? 0;
  }

  heightAt(x: number, z: number): number {
    const fx = (x - this.min) / FIELD_STEP;
    const fz = (z - this.min) / FIELD_STEP;
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
  // pair it with a vertexColors material.
  buildMesh(material: THREE.Material, colorAt?: (x: number, z: number, into: THREE.Color) => void): THREE.Mesh {
    const span = WORLD_SIZE * 1.08;
    const segs = Math.min(400, Math.max(120, Math.round(span / 3))); // ~3u per quad
    const geo = new THREE.PlaneGeometry(span, span, segs, segs);
    const pos = geo.attributes.position;
    if (pos instanceof THREE.BufferAttribute) {
      const colors = colorAt ? new Float32Array(pos.count * 3) : null;
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i);
        const py = pos.getY(i); // after the -90° X rotation, local +Y → world -Z
        pos.setZ(i, this.heightAt(px, -py));
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
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    return mesh;
  }
}
