import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";

import { WORLD_H, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W } from "../shared/constants";
import type { Solid } from "../world/city";
import type { Terrain } from "../world/terrain";

// Rapier-backed rigid-body world for everything the taxi is NOT: traffic cars
// become dynamic bodies when punted, and slide/tumble against the terrain and
// the city's static colliders. The taxi itself stays on the custom arcade
// controller — kinematic feel is the game — it just applies impulses here.

const FIXED_DT = 1 / 60;
const MAX_STEPS = 4; // per frame; drop time beyond this (tab-back spike guard)
// World units between terrain collider samples. The car's height is kinematic
// (city.heightAt), so this trimesh only serves loose bodies (cones, debris,
// traffic punts) — a coarse sampling is plenty and keeps the collider from
// exploding on the full-size map (finer = O(area) triangles for Rapier's BVH).
const GROUND_SAMPLE = 8;
const STATIC_HALF_HEIGHT = 6; // buildings/walls modeled as tall boxes

export class PhysicsWorld {
  private world: RAPIER.World;
  private acc = 0;

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    return new PhysicsWorld();
  }

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -30, z: 0 });
    this.world.timestep = FIXED_DT;
  }

  // Terrain as a trimesh sampled from the same height field the game drives on.
  addGround(terrain: Terrain): void {
    const spanX = WORLD_W * 1.06;
    const spanZ = WORLD_H * 1.06;
    const nx = Math.ceil(spanX / GROUND_SAMPLE);
    const nz = Math.ceil(spanZ / GROUND_SAMPLE);
    const verts = new Float32Array((nx + 1) * (nz + 1) * 3);
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= nz; j++) {
        const x = -spanX / 2 + (i / nx) * spanX;
        const z = -spanZ / 2 + (j / nz) * spanZ;
        const k = (i * (nz + 1) + j) * 3;
        verts[k] = x;
        verts[k + 1] = terrain.heightAt(x, z);
        verts[k + 2] = z;
      }
    }
    const indices = new Uint32Array(nx * nz * 6);
    let w = 0;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const a = i * (nz + 1) + j;
        const b = a + 1;
        const c = a + (nz + 1);
        const d = c + 1;
        indices[w++] = a;
        indices[w++] = b;
        indices[w++] = c;
        indices[w++] = b;
        indices[w++] = d;
        indices[w++] = c;
      }
    }
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(verts, indices).setFriction(0.9), body);
  }

  // City solids (buildings, walls, railings) as tall static boxes.
  addStaticSolids(solids: readonly Solid[], terrain: Terrain): void {
    for (const s of solids) {
      const cx = (s.minX + s.maxX) / 2;
      const cz = (s.minZ + s.maxZ) / 2;
      if (Math.abs(cx) > WORLD_HALF_X + 30 || Math.abs(cz) > WORLD_HALF_Z + 30) continue;
      const hx = Math.max(0.1, (s.maxX - s.minX) / 2);
      const hz = Math.max(0.1, (s.maxZ - s.minZ) / 2);
      const base = terrain.heightAt(cx, cz);
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(cx, base + STATIC_HALF_HEIGHT - 1, cz),
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, STATIC_HALF_HEIGHT, hz).setFriction(0.6),
        body,
      );
    }
  }

  // A traffic car: kinematic while it follows its route, dynamic once punted.
  createCarBody(x: number, y: number, z: number): RAPIER.RigidBody {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(x, y, z)
        .setLinearDamping(1.1)
        .setAngularDamping(1.6),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(1.0, 0.75, 1.25)
        .setFriction(0.7)
        .setRestitution(0.25)
        .setDensity(1.4),
      body,
    );
    return body;
  }

  // A launched traffic cone: light dynamic cylinder born with its fling velocity.
  createConeBody(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
  ): RAPIER.RigidBody {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setLinvel(vx, vy, vz)
        .setAngvel({ x: vz * 0.8, y: 0, z: -vx * 0.8 }) // tumble across travel
        .setLinearDamping(0.3)
        .setAngularDamping(1.1),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cylinder(0.42, 0.3).setFriction(0.8).setRestitution(0.35).setDensity(0.5),
      body,
    );
    return body;
  }

  // A parked car: kinematic (stays exactly put) until the taxi punts it, then
  // makeDynamic() lets it bounce. Yawed to face along its curb.
  createParkedBody(x: number, y: number, z: number, yaw: number): RAPIER.RigidBody {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(x, y, z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setLinearDamping(1.1)
        .setAngularDamping(1.6),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(1.0, 0.75, 1.25)
        .setFriction(0.7)
        .setRestitution(0.3)
        .setDensity(1.4),
      body,
    );
    return body;
  }

  remove(body: RAPIER.RigidBody): void {
    this.world.removeRigidBody(body);
  }

  makeDynamic(body: RAPIER.RigidBody): void {
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  }

  makeKinematic(body: RAPIER.RigidBody): void {
    body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  }

  teleport(body: RAPIER.RigidBody, x: number, y: number, z: number, q: THREE.Quaternion): void {
    body.setTranslation({ x, y, z }, false);
    body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, false);
    body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  }

  step(dt: number): void {
    this.acc += dt;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < MAX_STEPS) {
      this.world.step();
      this.acc -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;
  }
}
