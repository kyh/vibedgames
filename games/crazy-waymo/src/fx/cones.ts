import type { RigidBody } from "@dimforge/rapier3d-compat";
import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl, PROP_CONE } from "../assets/manifest";
import type { PhysicsWorld } from "../physics/physics-world";
import { ROAD_TILE } from "../shared/constants";
import type { Rng } from "../shared/rng";
import type { CityModel } from "../world/city";
import { toFloat32Attributes } from "../world/conform";

// Smashable traffic cones — the free destruction toy. Scattered on road
// shoulders; driving through one hands it to the physics world, so cones
// scatter into piles, carom off buildings and tumble down hills. One
// InstancedMesh, zero draw-call growth; a body exists only while flying.

const COUNT = 64;
const HIT_RADIUS = 1.7;
const REST_SPEED = 0.7; // slower than this (for REST_TIME) → settle
const REST_TIME = 0.7;
const MAX_FLIGHT_S = 8; // runaway cones eventually settle wherever they are

type ConeState = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  quat: THREE.Quaternion; // pose while physics-driven / settled
  body: RigidBody | null;
  restTimer: number;
  flightTime: number;
  // resting = smashable; physical = rapier-driven; fading = despawn; dead = hidden
  mode: "resting" | "physical" | "fading" | "dead";
  fade: number;
};

export class SmashCones {
  readonly mesh: THREE.InstancedMesh;
  private cones: ConeState[] = [];
  private homes: { x: number; y: number; z: number; yaw: number; live: boolean }[] = [];
  private mat4 = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private eul = new THREE.Euler();
  private scl = new THREE.Vector3();
  private posV = new THREE.Vector3();

  constructor(
    cache: ModelCache,
    private city: CityModel,
    rng: Rng,
    private physics: PhysicsWorld | null = null,
  ) {
    // Pull geometry + material out of the cone GLB (first mesh wins). The node
    // matrix must be baked in — meshopt-quantized GLBs store the dequantization
    // scale there, so raw geometry is integer-sized.
    const url = modelUrl("props", PROP_CONE);
    const template = cache.instance(url);
    template.updateMatrixWorld(true);
    let geo: THREE.BufferGeometry = new THREE.ConeGeometry(0.3, 0.7, 8);
    let mat: THREE.Material = new THREE.MeshStandardMaterial({ color: 0xe06428 });
    let nodeMatrix = new THREE.Matrix4();
    template.traverse((c) => {
      if (c instanceof THREE.Mesh && c.geometry instanceof THREE.BufferGeometry) {
        if (!Array.isArray(c.material)) {
          geo = c.geometry;
          mat = c.material;
          nodeMatrix = c.matrixWorld.clone();
        }
      }
    });
    const b = cache.bounds(url);
    const scale = 0.85 / Math.max(b.size.y, 0.001);
    const scaled = geo.clone();
    toFloat32Attributes(scaled); // meshopt attrs are quantized; matrix bake writes floats
    scaled.applyMatrix4(nodeMatrix);
    scaled.scale(scale, scale, scale);
    this.mesh = new THREE.InstancedMesh(scaled, mat, COUNT);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;

    // Scatter little clusters along road shoulders, away from the spawn.
    const cells = city.roadCells.filter((c) => {
      const cx = (city.plan.sizeX - 1) / 2;
      const cz = (city.plan.sizeZ - 1) / 2;
      return Math.abs(c.gx - cx) + Math.abs(c.gz - cz) > 5;
    });
    let placed = 0;
    while (placed < COUNT && cells.length > 0) {
      const cell = rng.pick(cells);
      const n = Math.min(COUNT - placed, 1 + rng.int(3));
      const side = rng.chance(0.5) ? 1 : -1;
      // Snap the cluster onto the real street: shoulder of the nearest EDGE
      // (cell centres can sit a half-tile off the vector road).
      const hit = city.network.nearest(city.worldX(cell.gx), city.worldZ(cell.gz), ROAD_TILE * 1.2);
      if (!hit) continue;
      const shoulder = hit.edge.half - 1.1;
      for (let i = 0; i < n; i++) {
        const along = (i - 1) * 1.3;
        const x = hit.x + hit.tx * along - hit.tz * shoulder * side + rng.range(-0.4, 0.4);
        const z = hit.z + hit.tz * along + hit.tx * shoulder * side + rng.range(-0.4, 0.4);
        this.cones.push({
          x,
          y: city.terrain.heightAt(x, z),
          z,
          yaw: rng.range(0, Math.PI * 2),
          quat: new THREE.Quaternion(),
          body: null,
          restTimer: 0,
          flightTime: 0,
          mode: "resting",
          fade: 1,
        });
        placed++;
      }
    }
    while (this.cones.length < COUNT) {
      this.cones.push({
        x: 0,
        y: -50,
        z: 0,
        yaw: 0,
        quat: new THREE.Quaternion(),
        body: null,
        restTimer: 0,
        flightTime: 0,
        mode: "dead",
        fade: 0,
      });
    }
    this.homes = this.cones.map((c) => ({
      x: c.x,
      y: c.y,
      z: c.z,
      yaw: c.yaw,
      live: c.mode === "resting",
    }));
    this.writeAll();
  }

  // Restock every cone at its original curb spot (new run).
  reset(): void {
    for (let i = 0; i < this.cones.length; i++) {
      const c = this.cones[i];
      const h = this.homes[i];
      if (!c || !h) continue;
      this.releaseBody(c);
      c.x = h.x;
      c.y = h.y;
      c.z = h.z;
      c.yaw = h.yaw;
      c.quat.identity();
      c.restTimer = 0;
      c.flightTime = 0;
      c.fade = 1;
      c.mode = h.live ? "resting" : "dead";
    }
    this.writeAll();
  }

  // DEV: where the resting cones are (verification harness).
  restingPositions(): { x: number; z: number }[] {
    return this.cones.filter((c) => c.mode === "resting").map((c) => ({ x: c.x, z: c.z }));
  }

  // Launch any resting cone the car clips. Returns how many were smashed.
  tryHit(x: number, z: number, vx: number, vz: number): number {
    let hits = 0;
    for (const c of this.cones) {
      if (c.mode !== "resting") continue;
      const dx = c.x - x;
      const dz = c.z - z;
      if (dx * dx + dz * dz > HIT_RADIUS * HIT_RADIUS) continue;
      const sp = Math.hypot(vx, vz);
      const dir = sp > 1 ? { x: vx / sp, z: vz / sp } : { x: dx, z: dz };
      if (this.physics) {
        c.mode = "physical";
        c.restTimer = 0;
        c.flightTime = 0;
        c.body = this.physics.createConeBody(
          c.x,
          c.y + 0.5,
          c.z,
          dir.x * sp * 0.55 + dx * 2,
          5.5 + Math.min(6, sp * 0.12),
          dir.z * sp * 0.55 + dz * 2,
        );
      } else {
        // No physics (wasm failed): just despawn with a fade.
        c.mode = "fading";
        c.fade = 1;
      }
      hits++;
    }
    return hits;
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < this.cones.length; i++) {
      const c = this.cones[i];
      if (!c || c.mode === "resting" || c.mode === "dead") continue;
      dirty = true;
      if (c.mode === "physical" && c.body) {
        const t = c.body.translation();
        const r = c.body.rotation();
        c.x = t.x;
        c.y = t.y - 0.42; // collider centre → mesh base
        c.z = t.z;
        c.quat.set(r.x, r.y, r.z, r.w);
        c.flightTime += dt;
        const v = c.body.linvel();
        const speedSq = v.x * v.x + v.y * v.y + v.z * v.z;
        c.restTimer = speedSq < REST_SPEED * REST_SPEED ? c.restTimer + dt : 0;
        if (c.restTimer > REST_TIME || c.flightTime > MAX_FLIGHT_S || c.y < -12) {
          this.releaseBody(c);
          c.mode = "fading";
          c.fade = 1;
        }
      } else {
        c.fade -= dt / 2.5;
        if (c.fade <= 0) {
          c.mode = "dead";
          c.y = -50;
        }
      }
      this.write(i);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  private write(i: number): void {
    const c = this.cones[i];
    if (!c) return;
    if (c.mode === "resting") {
      this.eul.set(0, c.yaw, 0);
      this.quat.setFromEuler(this.eul);
    } else {
      this.quat.copy(c.quat);
    }
    const s = c.mode === "fading" ? Math.max(0.001, c.fade) : 1;
    this.scl.set(s, s, s);
    this.posV.set(c.x, c.y, c.z);
    this.mat4.compose(this.posV, this.quat, this.scl);
    this.mesh.setMatrixAt(i, this.mat4);
  }

  private releaseBody(c: ConeState): void {
    if (c.body && this.physics) this.physics.remove(c.body);
    c.body = null;
  }

  private writeAll(): void {
    for (let i = 0; i < this.cones.length; i++) this.write(i);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
