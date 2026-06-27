import * as THREE from "three";

import { WORLD_SIZE } from "../shared/constants";

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

// Smooth terrain: gentle island base that dips under the ocean at the coast,
// plus a sum of Gaussian hills. Sampled by roads, buildings, the car, traffic,
// fares and the camera so the whole city rolls like San Francisco.
export class Terrain {
  constructor(
    private hills: readonly Hill[],
    private land: LandFactor,
  ) {}

  heightAt(x: number, z: number): number {
    const u = worldToU(x);
    const v = worldToV(z);
    const landAmt = this.land(u, v); // 0 water .. 1 inland
    // Plateau (height ~0.3) covers everything buildable; the dip to the ocean
    // happens in the 0.28..0.42 band, which sits beyond the road mask (>0.5).
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

  // Surface normal from the height gradient (central differences).
  normalInto(out: THREE.Vector3, x: number, z: number): THREE.Vector3 {
    const e = 1.6;
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
