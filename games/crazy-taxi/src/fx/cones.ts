import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl, PROP_CONE } from "../assets/manifest";
import { ROAD_TILE } from "../shared/constants";
import type { Rng } from "../shared/rng";
import type { CityModel } from "../world/city";

// Smashable traffic cones — the free destruction toy. Scattered on road
// shoulders; driving through one launches it ballistically (+$ and a spark
// burst are the scene's job). One InstancedMesh, zero draw-call growth.

const COUNT = 64;
const HIT_RADIUS = 1.7;
const GRAVITY = 26;

type ConeState = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spinX: number;
  spinZ: number;
  rotX: number;
  rotZ: number;
  yaw: number;
  // resting = smashable; flying = ballistic; fading = despawning; dead = hidden
  mode: "resting" | "flying" | "fading" | "dead";
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
  ) {
    // Pull geometry + material out of the cone GLB (first mesh wins).
    const url = modelUrl("props", PROP_CONE);
    const template = cache.instance(url);
    let geo: THREE.BufferGeometry = new THREE.ConeGeometry(0.3, 0.7, 8);
    let mat: THREE.Material = new THREE.MeshStandardMaterial({ color: 0xe06428 });
    template.traverse((c) => {
      if (c instanceof THREE.Mesh && c.geometry instanceof THREE.BufferGeometry) {
        if (!Array.isArray(c.material)) {
          geo = c.geometry;
          mat = c.material;
        }
      }
    });
    const b = cache.bounds(url);
    const scale = 0.85 / Math.max(b.size.y, 0.001);
    const scaled = geo.clone();
    scaled.scale(scale, scale, scale);
    this.mesh = new THREE.InstancedMesh(scaled, mat, COUNT);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;

    // Scatter little clusters along road shoulders, away from the spawn.
    const cells = city.roadCells.filter((c) => {
      const cGrid = (city.plan.size - 1) / 2;
      return Math.abs(c.gx - cGrid) + Math.abs(c.gz - cGrid) > 5;
    });
    let placed = 0;
    while (placed < COUNT && cells.length > 0) {
      const cell = rng.pick(cells);
      const n = Math.min(COUNT - placed, 1 + rng.int(3));
      const side = rng.chance(0.5) ? 1 : -1;
      const alongX = rng.chance(0.5);
      for (let i = 0; i < n; i++) {
        const ox = alongX ? (i - 1) * 1.3 : side * ROAD_TILE * 0.33;
        const oz = alongX ? side * ROAD_TILE * 0.33 : (i - 1) * 1.3;
        const x = city.worldX(cell.gx) + ox + rng.range(-0.4, 0.4);
        const z = city.worldZ(cell.gz) + oz + rng.range(-0.4, 0.4);
        this.cones.push({
          x,
          y: city.terrain.heightAt(x, z),
          z,
          vx: 0,
          vy: 0,
          vz: 0,
          spinX: 0,
          spinZ: 0,
          rotX: 0,
          rotZ: 0,
          yaw: rng.range(0, Math.PI * 2),
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
        vx: 0,
        vy: 0,
        vz: 0,
        spinX: 0,
        spinZ: 0,
        rotX: 0,
        rotZ: 0,
        yaw: 0,
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
      c.x = h.x;
      c.y = h.y;
      c.z = h.z;
      c.yaw = h.yaw;
      c.vx = 0;
      c.vy = 0;
      c.vz = 0;
      c.spinX = 0;
      c.spinZ = 0;
      c.rotX = 0;
      c.rotZ = 0;
      c.fade = 1;
      c.mode = h.live ? "resting" : "dead";
    }
    this.writeAll();
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
      c.mode = "flying";
      c.vx = dir.x * sp * 0.55 + dx * 2;
      c.vz = dir.z * sp * 0.55 + dz * 2;
      c.vy = 5.5 + Math.min(6, sp * 0.12);
      c.spinX = 4 + Math.random() * 9;
      c.spinZ = (Math.random() - 0.5) * 10;
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
      if (c.mode === "flying") {
        c.vy -= GRAVITY * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.z += c.vz * dt;
        c.rotX += c.spinX * dt;
        c.rotZ += c.spinZ * dt;
        const ground = this.city.terrain.heightAt(c.x, c.z);
        if (c.y <= ground && c.vy < 0) {
          if (Math.abs(c.vy) > 4) {
            c.y = ground;
            c.vy = -c.vy * 0.35;
            c.vx *= 0.6;
            c.vz *= 0.6;
            c.spinX *= 0.5;
            c.spinZ *= 0.5;
          } else {
            c.y = ground;
            c.mode = "fading";
            c.fade = 1;
          }
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
    this.eul.set(c.rotX, c.yaw, c.rotZ);
    this.quat.setFromEuler(this.eul);
    const s = c.mode === "fading" ? Math.max(0.001, c.fade) : 1;
    this.scl.set(s, s, s);
    this.posV.set(c.x, c.y, c.z);
    this.mat4.compose(this.posV, this.quat, this.scl);
    this.mesh.setMatrixAt(i, this.mat4);
  }

  private writeAll(): void {
    for (let i = 0; i < this.cones.length; i++) this.write(i);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
