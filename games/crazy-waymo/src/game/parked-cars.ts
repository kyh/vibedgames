import type { RigidBody } from "@dimforge/rapier3d-compat";
import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl } from "../assets/manifest";
import type { PhysicsWorld } from "../physics/physics-world";
import type { ParkedSpec } from "../world/furniture";

// Parked cars at the curb. The 2x-density city parks thousands of them, so
// they render as BatchedMesh instances (one batch per material/layout — a
// handful of draw calls total) and carry NO physics body until the taxi
// actually rams one: the body is created lazily on first punt, goes dynamic,
// and the car's batch instances follow it while it tumbles.

const BODY_LIFT = 0.8; // body centre above the mesh origin (wheels)
const HIT_RADIUS = 2.6;
const OFFSET = new THREE.Vector3();

type PartRef = { batch: THREE.BatchedMesh; instanceId: number; local: THREE.Matrix4 };

type Parked = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  parts: PartRef[];
  body: RigidBody | null;
  hit: boolean;
};

type TemplatePart = { geo: THREE.BufferGeometry; mat: THREE.Material; local: THREE.Matrix4 };

const CULL_DIST = 340; // parked cars are street detail — cull with props
const CULL_DIST_SQ = CULL_DIST * CULL_DIST;

export class ParkedCars {
  readonly group = new THREE.Group();
  private cars: Parked[] = [];
  private tmp = new THREE.Quaternion();
  private mat4 = new THREE.Matrix4();
  private carMat4 = new THREE.Matrix4();
  private visible: Uint8Array = new Uint8Array(0);
  private cullCursor = 0;

  constructor(
    cache: ModelCache,
    specs: readonly ParkedSpec[],
    private physics: PhysicsWorld,
    heightAt: (x: number, z: number) => number,
  ) {
    // Template parts per model (geometry + material + local transform).
    const templates = new Map<string, TemplatePart[]>();
    const partsOf = (model: string): TemplatePart[] => {
      let parts = templates.get(model);
      if (parts) return parts;
      parts = [];
      const node = cache.instance(modelUrl("cars", model));
      node.updateMatrixWorld(true);
      node.traverse((c) => {
        if (c instanceof THREE.Mesh && c.geometry instanceof THREE.BufferGeometry && !Array.isArray(c.material)) {
          parts?.push({ geo: c.geometry, mat: c.material, local: c.matrixWorld.clone() });
        }
      });
      templates.set(model, parts);
      return parts;
    };

    // Size batches per (material, attribute layout).
    type Bucket = {
      mat: THREE.Material;
      geos: Set<THREE.BufferGeometry>;
      verts: number;
      indices: number;
      count: number;
      batch?: THREE.BatchedMesh;
      geoIds?: Map<THREE.BufferGeometry, number>;
    };
    const buckets = new Map<string, Bucket>();
    const keyOf = (p: TemplatePart): string =>
      `${p.mat.uuid}|${Object.keys(p.geo.attributes).sort().join(",")}|${p.geo.index ? "i" : "n"}`;
    for (const s of specs) {
      for (const p of partsOf(s.model)) {
        const k = keyOf(p);
        let b = buckets.get(k);
        if (!b) {
          b = { mat: p.mat, geos: new Set(), verts: 0, indices: 0, count: 0 };
          buckets.set(k, b);
        }
        if (!b.geos.has(p.geo)) {
          b.geos.add(p.geo);
          const v = p.geo.attributes.position?.count ?? 0;
          b.verts += v;
          b.indices += p.geo.index ? p.geo.index.count : v;
        }
        b.count++;
      }
    }
    for (const b of buckets.values()) {
      const batch = new THREE.BatchedMesh(b.count, b.verts, Math.max(b.indices, 3), b.mat);
      batch.castShadow = true;
      batch.frustumCulled = false; // per-instance culling stays on inside
      b.batch = batch;
      b.geoIds = new Map();
      this.group.add(batch);
    }

    for (const s of specs) {
      const y = heightAt(s.x, s.z);
      this.carMat4.makeRotationY(s.yaw).setPosition(s.x, y, s.z);
      const parts: PartRef[] = [];
      for (const p of partsOf(s.model)) {
        const b = buckets.get(keyOf(p));
        if (!b || !b.batch || !b.geoIds) continue;
        let gid = b.geoIds.get(p.geo);
        if (gid === undefined) {
          gid = b.batch.addGeometry(p.geo);
          b.geoIds.set(p.geo, gid);
        }
        const iid = b.batch.addInstance(gid);
        this.mat4.multiplyMatrices(this.carMat4, p.local);
        b.batch.setMatrixAt(iid, this.mat4);
        parts.push({ batch: b.batch, instanceId: iid, local: p.local });
      }
      this.cars.push({ x: s.x, y, z: s.z, yaw: s.yaw, parts, body: null, hit: false });
    }
    for (const b of buckets.values()) b.batch?.computeBoundingSphere();
    this.visible = new Uint8Array(this.cars.length).fill(1);
  }

  // Distance-cull instances (transitions only, amortised across frames).
  // BatchedMesh gives per-instance FRUSTUM culling for free, but without
  // this every parked car in view direction draws from kilometres away.
  updateCulling(camX: number, camZ: number): void {
    const n = this.cars.length;
    if (n === 0) return;
    const step = Math.max(1, Math.ceil(n / 6)); // full sweep every ~6 frames
    for (let i = 0; i < step; i++) {
      const idx = (this.cullCursor + i) % n;
      const c = this.cars[idx];
      if (!c) continue;
      const dx = c.x - camX;
      const dz = c.z - camZ;
      const vis: 0 | 1 = c.hit || dx * dx + dz * dz < CULL_DIST_SQ ? 1 : 0;
      if (this.visible[idx] !== vis) {
        this.visible[idx] = vis;
        for (const p of c.parts) p.batch.setVisibleAt(p.instanceId, vis === 1);
      }
    }
    this.cullCursor = (this.cullCursor + step) % n;
  }

  // The taxi rammed near (x,z): punt the closest parked car it's touching.
  punt(x: number, z: number, nx: number, nz: number, impact: number): boolean {
    let best: Parked | null = null;
    let bestD = HIT_RADIUS * HIT_RADIUS;
    for (const c of this.cars) {
      const dx = c.x - x;
      const dz = c.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = c;
      }
    }
    if (!best) return false;
    if (!best.hit) {
      // Lazy body: parked cars carry no physics until this moment.
      best.body = this.physics.createParkedBody(best.x, best.y + BODY_LIFT, best.z, best.yaw);
      this.physics.makeDynamic(best.body);
      best.hit = true;
    }
    if (!best.body) return false;
    const shove = Math.max(impact * 0.9, 3.5);
    const v = best.body.linvel();
    best.body.setLinvel(
      { x: v.x * 0.3 + nx * shove, y: Math.max(v.y, Math.min(4, impact * 0.16)), z: v.z * 0.3 + nz * shove },
      true,
    );
    return true;
  }

  // After the physics step: punted cars' batch instances follow their bodies.
  sync(): void {
    for (const c of this.cars) {
      if (!c.hit || !c.body) continue;
      const t = c.body.translation();
      const r = c.body.rotation();
      this.tmp.set(r.x, r.y, r.z, r.w);
      OFFSET.set(0, BODY_LIFT, 0).applyQuaternion(this.tmp);
      this.carMat4.makeRotationFromQuaternion(this.tmp);
      this.carMat4.setPosition(t.x - OFFSET.x, t.y - OFFSET.y, t.z - OFFSET.z);
      // Track live position so repeat punts find the car where it now is.
      c.x = t.x;
      c.z = t.z;
      for (const p of c.parts) {
        this.mat4.multiplyMatrices(this.carMat4, p.local);
        p.batch.setMatrixAt(p.instanceId, this.mat4);
      }
    }
  }
}
