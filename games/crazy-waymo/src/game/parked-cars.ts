import { reachScale } from "../render/quality";
import type { RigidBody } from "#rapier";
import * as THREE from "three";

import { geoLayoutKey } from "../assets/loader";
import type { ModelCache } from "../assets/loader";
import { modelUrl } from "../assets/manifest";
import type { PhysicsWorld } from "../physics/physics-world";
import type { ParkedSpec } from "../world/furniture";

// Parked cars at the curb. The 2x-density city parks thousands of them, so
// they render as BatchedMesh instances (one batch per material/layout — a
// handful of draw calls total) and carry NO physics body until the taxi
// actually rams one: the body is created lazily on first punt, goes dynamic,
// and the car's batch instances follow it while it tumbles.

// body centre above the mesh origin (wheels)
const BODY_LIFT = 0.8;
const HIT_RADIUS = 2.6;
const OFFSET = new THREE.Vector3();
const EULER = new THREE.Euler();

interface PartRef {
  batch: THREE.BatchedMesh;
  instanceId: number;
  local: THREE.Matrix4;
}

interface Parked {
  x: number;
  y: number;
  z: number;
  yaw: number;
  // Curb spec spot: x/z track the live body after a punt (sync), so the
  // trailer's restore() needs the originals to re-park the car.
  homeX: number;
  homeZ: number;
  parts: PartRef[];
  body: RigidBody | null;
  hit: boolean;
  /** TRAILER: staged plow-row car — punts with a light body (mass ~30 vs the
   *  normal 135) so the full-speed plow launches it instead of spinning the
   *  taxi out. Never set in normal play. */
  light: boolean;
}

interface TemplatePart {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  local: THREE.Matrix4;
}

// parked cars are street detail — cull with props
const bucketKey = (p: TemplatePart): string => `${p.mat.uuid}|${geoLayoutKey(p.geo)}`;

const CULL_DIST = 340;
// Phones see less street; the shorter world keeps its cars with it.
const cullDistSq = (): number => (CULL_DIST * reachScale()) ** 2;

export class ParkedCars {
  readonly group = new THREE.Group();
  private cars: Parked[] = [];
  private tmp = new THREE.Quaternion();
  private mat4 = new THREE.Matrix4();
  private carMat4 = new THREE.Matrix4();
  private visible: Uint8Array = new Uint8Array(0);
  private cullCursor = 0;

  private physics: PhysicsWorld;
  private readonly heightAt: (x: number, z: number) => number;

  constructor(
    cache: ModelCache,
    specs: readonly ParkedSpec[],
    physics: PhysicsWorld,
    heightAt: (x: number, z: number) => number,
  ) {
    this.physics = physics;
    this.heightAt = heightAt;
    // Template parts per model (geometry + material + local transform).
    const templates = new Map<string, TemplatePart[]>();
    const partsOf = (model: string): TemplatePart[] => {
      let parts = templates.get(model);
      if (parts) {
        return parts;
      }
      parts = [];
      const node = cache.instance(modelUrl("cars", model));
      node.updateMatrixWorld(true);
      node.traverse((c) => {
        if (
          c instanceof THREE.Mesh &&
          c.geometry instanceof THREE.BufferGeometry &&
          !Array.isArray(c.material)
        ) {
          parts?.push({ geo: c.geometry, local: c.matrixWorld.clone(), mat: c.material });
        }
      });
      templates.set(model, parts);
      return parts;
    };

    // Size batches per (material, attribute layout).
    interface Bucket {
      mat: THREE.Material;
      geos: Set<THREE.BufferGeometry>;
      verts: number;
      indices: number;
      count: number;
      batch?: THREE.BatchedMesh;
      geoIds?: Map<THREE.BufferGeometry, number>;
    }
    const buckets = new Map<string, Bucket>();
    for (const s of specs) {
      for (const p of partsOf(s.model)) {
        const k = bucketKey(p);
        let b = buckets.get(k);
        if (!b) {
          b = { count: 0, geos: new Set(), indices: 0, mat: p.mat, verts: 0 };
          buckets.set(k, b);
        }
        if (!b.geos.has(p.geo)) {
          b.geos.add(p.geo);
          const v = p.geo.attributes.position?.count ?? 0;
          b.verts += v;
          b.indices += p.geo.index ? p.geo.index.count : v;
        }
        b.count += 1;
      }
    }
    for (const b of buckets.values()) {
      const batch = new THREE.BatchedMesh(b.count, b.verts, Math.max(b.indices, 3), b.mat);
      batch.castShadow = true;
      // per-instance culling stays on inside
      batch.frustumCulled = false;
      b.batch = batch;
      b.geoIds = new Map();
      this.group.add(batch);
    }

    for (const s of specs) {
      const y = this.seatInto(s.x, s.z, s.yaw);
      const parts: PartRef[] = [];
      for (const p of partsOf(s.model)) {
        const b = buckets.get(bucketKey(p));
        if (!b || !b.batch || !b.geoIds) {
          continue;
        }
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
      this.cars.push({
        body: null,
        hit: false,
        homeX: s.x,
        homeZ: s.z,
        light: false,
        parts,
        x: s.x,
        y,
        yaw: s.yaw,
        z: s.z,
      });
    }
    for (const b of buckets.values()) {
      b.batch?.computeBoundingSphere();
    }
    this.visible = new Uint8Array(this.cars.length).fill(1);
  }

  /** Slope-seat pose at (x, z, yaw), written into this.carMat4; returns the
   *  seated y. Seats on the SLOPE, not a single centre sample: SF grades run
   *  to 30%, and a flat car there hangs its downhill wheels ~0.5u in the air.
   *  Samples both axles + both sides, pitches/rolls to match. */
  private seatInto(x: number, z: number, yaw: number): number {
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    // local +X after yaw
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const hF = this.heightAt(x + fx * 1.4, z + fz * 1.4);
    const hB = this.heightAt(x - fx * 1.4, z - fz * 1.4);
    const hR = this.heightAt(x + rx * 0.75, z + rz * 0.75);
    const hL = this.heightAt(x - rx * 0.75, z - rz * 0.75);
    const y = (hF + hB + hR + hL) / 4;
    // +X pitch dips the local forward (+Z); +Z roll lifts local +X.
    EULER.set(Math.atan2(hB - hF, 2.8), yaw, Math.atan2(hR - hL, 1.5), "YXZ");
    this.carMat4.makeRotationFromQuaternion(this.tmp.setFromEuler(EULER)).setPosition(x, y, z);
    return y;
  }

  /** TRAILER (src/trailer/): re-park every punted car at its curb spec —
   *  drop the Rapier body, re-seat the batch instances on the slope, clear
   *  `hit` — so replayed/looped takes stage against a fresh row. Normal play
   *  never calls this (wreckage persisting through a run is intended). */
  restore(): void {
    for (const c of this.cars) {
      if (!c.hit) {
        continue;
      }
      if (c.body) {
        this.physics.remove(c.body);
        c.body = null;
      }
      c.x = c.homeX;
      c.z = c.homeZ;
      c.y = this.seatInto(c.homeX, c.homeZ, c.yaw);
      for (const p of c.parts) {
        this.mat4.multiplyMatrices(this.carMat4, p.local);
        p.batch.setMatrixAt(p.instanceId, this.mat4);
      }
      c.hit = false;
    }
  }

  /** TRAILER (src/trailer/): relocate the `n` un-punted parked cars nearest
   *  the row start into a curbside line along (tx, tz) — the world's natural
   *  curb parking never exceeds ~3 aligned cars, so the chaos scene stages
   *  its own row. Homes move WITH the cars: restore() re-parks a punted row
   *  car back into the line, so looped takes replay against the same row. */
  stageRow(x0: number, z0: number, tx: number, tz: number, n: number, spacing: number): void {
    const yaw = Math.atan2(tx, tz);
    const picked = [...this.cars]
      .filter((c) => !c.hit)
      .toSorted((a, b) => {
        const da = (a.x - x0) * (a.x - x0) + (a.z - z0) * (a.z - z0);
        const db = (b.x - x0) * (b.x - x0) + (b.z - z0) * (b.z - z0);
        return da - db;
      })
      .slice(0, n);
    for (const [i, c] of picked.entries()) {
      c.homeX = x0 + tx * spacing * i;
      c.x = c.homeX;
      c.homeZ = z0 + tz * spacing * i;
      c.z = c.homeZ;
      c.yaw = yaw;
      c.light = true;
      c.y = this.seatInto(c.x, c.z, c.yaw);
      for (const p of c.parts) {
        this.mat4.multiplyMatrices(this.carMat4, p.local);
        p.batch.setMatrixAt(p.instanceId, this.mat4);
      }
    }
  }

  // Distance-cull instances (transitions only, amortised across frames).
  // BatchedMesh gives per-instance FRUSTUM culling for free, but without
  // this every parked car in view direction draws from kilometres away.
  updateCulling(camX: number, camZ: number): void {
    const n = this.cars.length;
    if (n === 0) {
      return;
    }
    // full sweep every ~6 frames
    this.cullRange(camX, camZ, this.cullCursor, Math.max(1, Math.ceil(n / 6)));
  }

  /** One synchronous sweep of every car — for the first frame, before the
   *  amortised cull has been round once. Every placed car starts visible, and
   *  the title's hilltop orbit sees thousands of them at once otherwise. */
  cullAll(camX: number, camZ: number): void {
    this.cullRange(camX, camZ, 0, this.cars.length);
  }

  private cullRange(camX: number, camZ: number, from: number, count: number): void {
    const n = this.cars.length;
    const limit = cullDistSq();
    for (let i = 0; i < count; i += 1) {
      const idx = (from + i) % n;
      const c = this.cars[idx];
      if (!c) {
        continue;
      }
      const dx = c.x - camX;
      const dz = c.z - camZ;
      const vis: 0 | 1 = c.hit || dx * dx + dz * dz < limit ? 1 : 0;
      if (this.visible[idx] !== vis) {
        this.visible[idx] = vis;
        for (const p of c.parts) {
          p.batch.setVisibleAt(p.instanceId, vis === 1);
        }
      }
    }
    this.cullCursor = (from + count) % n;
  }

  // The taxi rammed near (px,pz) moving at (vx,vz): hand the parked car it's
  // about to touch to Rapier. Predictive like traffic — fire at the contact
  // radius plus the ground covered this frame, but only when actually closing.
  // The car's real weight then carries the exchange (the taxi shoves it via a
  // real contact). Returns the taxi's closing speed toward the car (0 = no hit).
  tryPunt(px: number, pz: number, vx: number, vz: number, dt: number): number {
    const speed = Math.hypot(vx, vz);
    // this frame's travel widens the search
    const searchR = HIT_RADIUS + speed * dt;
    let best: Parked | null = null;
    let bestD = searchR * searchR;
    for (const c of this.cars) {
      const dx = c.x - px;
      const dz = c.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = c;
      }
    }
    if (!best) {
      return 0;
    }
    const d = Math.sqrt(bestD);
    if (d < 1e-4) {
      return 0;
    }
    const nx = (best.x - px) / d;
    const nz = (best.z - pz) / d;
    // taxi speed toward the car
    const closing = vx * nx + vz * nz;
    const reach = HIT_RADIUS + Math.max(0, closing) * dt;
    if (d > reach) {
      return 0;
    }
    if (closing < 0.4 && d > HIT_RADIUS) {
      return 0;
    }
    if (!best.hit) {
      // Lazy body, created the frame contact is imminent; from here Rapier +
      // the taxi's momentum do the shoving (pure physics — no scripted push).
      best.body = this.physics.createParkedBody(
        best.x,
        best.y + BODY_LIFT,
        best.z,
        best.yaw,
        best.light ? 4 : 18,
      );
      this.physics.makeDynamic(best.body);
      best.hit = true;
    }
    return closing;
  }

  // After the physics step: punted cars' batch instances follow their bodies.
  sync(): void {
    for (const c of this.cars) {
      if (!c.hit || !c.body) {
        continue;
      }
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
