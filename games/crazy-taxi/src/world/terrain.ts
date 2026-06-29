import * as THREE from "three";

import { GRID, ROAD_TILE, WORLD_HALF, WORLD_SIZE } from "../shared/constants";

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

// Grid-quantized terrain: the underlying SF hill field is sampled once per grid
// cell centre, then bilinearly interpolated. Because every road tile owns one
// cell, each tile tilts to bridge its neighbours' cell heights and meets them at
// shared edges — the road surface stays gap-free and grid-aligned on the hills.
export class Terrain {
  private cellH: Float64Array;

  constructor(
    private hills: readonly Hill[],
    private land: LandFactor,
  ) {
    this.cellH = new Float64Array(GRID * GRID);
    for (let gx = 0; gx < GRID; gx++) {
      for (let gz = 0; gz < GRID; gz++) {
        const x = (gx + 0.5) * ROAD_TILE - WORLD_HALF;
        const z = (gz + 0.5) * ROAD_TILE - WORLD_HALF;
        this.cellH[gx * GRID + gz] = this.rawHeight(x, z);
      }
    }
  }

  // The raw continuous SF field (island base + Gaussian hills) before grid-snap.
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

  private cellHeight(gx: number, gz: number): number {
    const cx = Math.min(GRID - 1, Math.max(0, gx));
    const cz = Math.min(GRID - 1, Math.max(0, gz));
    return this.cellH[cx * GRID + cz] ?? 0;
  }

  heightAt(x: number, z: number): number {
    const cf = (x + WORLD_HALF) / ROAD_TILE - 0.5;
    const cg = (z + WORLD_HALF) / ROAD_TILE - 0.5;
    const gx0 = Math.floor(cf);
    const gz0 = Math.floor(cg);
    const fx = cf - gx0;
    const fz = cg - gz0;
    const h00 = this.cellHeight(gx0, gz0);
    const h10 = this.cellHeight(gx0 + 1, gz0);
    const h01 = this.cellHeight(gx0, gz0 + 1);
    const h11 = this.cellHeight(gx0 + 1, gz0 + 1);
    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return a + (b - a) * fz;
  }

  // Surface normal from the cell-scale height gradient (matches the tile tilt).
  normalInto(out: THREE.Vector3, x: number, z: number): THREE.Vector3 {
    const e = ROAD_TILE * 0.5;
    const hl = this.heightAt(x - e, z);
    const hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e);
    const hu = this.heightAt(x, z + e);
    return out.set((hl - hr) / (2 * e), 1, (hd - hu) / (2 * e)).normalize();
  }

  landAt(x: number, z: number): number {
    return this.land(worldToU(x), worldToV(z));
  }

  // A displaced ground mesh covering the island (the ocean plane sits below it).
  buildMesh(material: THREE.Material): THREE.Mesh {
    const span = WORLD_SIZE * 1.04;
    const segs = 180;
    const geo = new THREE.PlaneGeometry(span, span, segs, segs);
    const pos = geo.attributes.position;
    if (pos instanceof THREE.BufferAttribute) {
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i);
        const py = pos.getY(i); // after the -90° X rotation, local +Y → world -Z
        pos.setZ(i, this.heightAt(px, -py));
      }
      pos.needsUpdate = true;
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    return mesh;
  }
}
