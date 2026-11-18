import { ColliderDesc, ready, RigidBodyDesc, RigidBodyType, World } from "#rapier";
import type { Collider, RigidBody } from "#rapier";
import type * as THREE from "three";

import { WORLD_H, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W } from "../shared/constants";
import type { Solid } from "../world/city";
import type { Terrain } from "../world/terrain";
import { staticSolidBox, staticSolidCollider } from "./static-solid";

const FIXED_DT = 1 / 60;
const MAX_STEPS = window.matchMedia("(pointer: coarse)").matches ? 2 : 4;
const GROUND_SAMPLE = 4;

const SOLID_STREAM_IN = 160;
const SOLID_STREAM_OUT = 200;
const SOLID_RESTREAM_DIST = 24;

const BOX_STRIDE = 8;
const BOX_REACH = 7;
const BASE_BLOCK = -1;

interface SolidBlock {
  readonly boxes: Float32Array;
  readonly count: number;
  readonly resident: Map<number, Collider>;
}

const boxAt = (b: Float32Array, i: number) => {
  const o = i * BOX_STRIDE;

  return {
    hx: b[o + 3] ?? 0,
    hy: b[o + 4] ?? 0,
    hz: b[o + 5] ?? 0,
    x: b[o] ?? 0,
    y: b[o + 1] ?? 0,
    yaw: b[o + 6] ?? 0,
    z: b[o + 2] ?? 0,
  };
};

export class PhysicsWorld {
  private world: World;
  private acc = 0;
  private readonly blocks = new Map<number, SolidBlock>();
  private streamX = Infinity;
  private streamZ = Infinity;

  static async create() {
    await ready();

    return new PhysicsWorld();
  }

  private constructor() {
    this.world = new World({ x: 0, y: -30, z: 0 });
    this.world.timestep = FIXED_DT;
  }

  raw() {
    return this.world;
  }

  addGround(heightAt: (x: number, z: number) => number) {
    const spanX = WORLD_W * 1.06;
    const spanZ = WORLD_H * 1.06;
    const ncols = Math.ceil(spanX / GROUND_SAMPLE);
    const nrows = Math.ceil(spanZ / GROUND_SAMPLE);
    const heights = new Float32Array((nrows + 1) * (ncols + 1));

    for (let col = 0; col <= ncols; col += 1) {
      const x = -spanX / 2 + (col / ncols) * spanX;

      for (let row = 0; row <= nrows; row += 1) {
        const z = -spanZ / 2 + (row / nrows) * spanZ;
        heights[col * (nrows + 1) + row] = heightAt(x, z);
      }
    }

    const body = this.world.createRigidBody(RigidBodyDesc.fixed());
    this.world.createCollider(
      ColliderDesc.heightfield(nrows, ncols, heights, {
        x: spanX,
        y: 1,
        z: spanZ,
      }).setFriction(0.9),
      body,
    );
  }

  addStaticTrimesh(positions: Float32Array) {
    const indices = new Uint32Array(positions.length / 3);

    for (let i = 0; i < indices.length; i += 1) {
      indices[i] = i;
    }

    const body = this.world.createRigidBody(RigidBodyDesc.fixed());
    this.world.createCollider(ColliderDesc.trimesh(positions, indices).setFriction(0.9), body);
  }

  addStaticSolids(solids: readonly Solid[], terrain: Terrain, tile = BASE_BLOCK) {
    this.removeStaticSolids(tile);
    const boxes = new Float32Array(solids.length * BOX_STRIDE);
    let count = 0;

    for (const s of solids) {
      if (s.noBody) {
        continue;
      }

      const cx = (s.minX + s.maxX) / 2;
      const cz = (s.minZ + s.maxZ) / 2;

      if (Math.abs(cx) > WORLD_HALF_X + 30 || Math.abs(cz) > WORLD_HALF_Z + 30) {
        continue;
      }

      const box = staticSolidBox(s, (x, z) => terrain.heightAt(x, z));
      const o = count * BOX_STRIDE;
      boxes[o] = box.x;
      boxes[o + 1] = box.y;
      boxes[o + 2] = box.z;
      boxes[o + 3] = box.hx;
      boxes[o + 4] = box.hy;
      boxes[o + 5] = box.hz;
      boxes[o + 6] = box.yaw;
      boxes[o + BOX_REACH] = Math.max(box.hx, box.hz);
      count += 1;
    }

    this.blocks.set(tile, { boxes, count, resident: new Map() });
    this.streamX = Infinity;
  }

  /** Drop a tile's boxes, resident colliders included. */
  removeStaticSolids(tile: number) {
    const block = this.blocks.get(tile);

    if (!block) {
      return;
    }

    for (const collider of block.resident.values()) {
      this.world.removeCollider(collider, true);
    }

    this.blocks.delete(tile);
  }

  streamSolids(x: number, z: number) {
    const moved = Math.hypot(x - this.streamX, z - this.streamZ);

    if (moved < SOLID_RESTREAM_DIST) {
      return;
    }

    this.streamX = x;
    this.streamZ = z;

    for (const block of this.blocks.values()) {
      const b = block.boxes;

      for (let i = 0; i < block.count; i += 1) {
        const o = i * BOX_STRIDE;
        const d = Math.hypot(x - (b[o] ?? 0), z - (b[o + 2] ?? 0)) - (b[o + BOX_REACH] ?? 0);
        const collider = block.resident.get(i);

        if (collider === undefined && d < SOLID_STREAM_IN) {
          block.resident.set(i, this.world.createCollider(staticSolidCollider(boxAt(b, i))));
        } else if (collider !== undefined && d > SOLID_STREAM_OUT) {
          this.world.removeCollider(collider, true);
          block.resident.delete(i);
        }
      }
    }
  }

  createCarBody(x: number, y: number, z: number) {
    const body = this.world.createRigidBody(
      RigidBodyDesc.kinematicPositionBased()
        .setTranslation(x, y, z)
        .setLinearDamping(1.8)
        .setAngularDamping(1.6),
    );

    this.world.createCollider(
      ColliderDesc.cuboid(1, 0.75, 1.25).setFriction(0.7).setRestitution(0.05).setDensity(18),
      body,
    );

    return body;
  }

  createConeBody(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const body = this.world.createRigidBody(
      RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setLinvel(vx, vy, vz)
        .setAngvel({ x: vz * 0.8, y: 0, z: -vx * 0.8 })
        .setLinearDamping(0.3)
        .setAngularDamping(1.1),
    );

    this.world.createCollider(
      ColliderDesc.cylinder(0.42, 0.3).setFriction(0.8).setRestitution(0.35).setDensity(0.5),
      body,
    );

    return body;
  }

  createParkedBody(x: number, y: number, z: number, yaw: number, density = 18) {
    const body = this.world.createRigidBody(
      RigidBodyDesc.kinematicPositionBased()
        .setTranslation(x, y, z)
        .setRotation({ w: Math.cos(yaw / 2), x: 0, y: Math.sin(yaw / 2), z: 0 })
        .setLinearDamping(1.8)
        .setAngularDamping(1.6),
    );

    this.world.createCollider(
      ColliderDesc.cuboid(1, 0.75, 1.25).setFriction(0.7).setRestitution(0.05).setDensity(density),
      body,
    );

    return body;
  }

  remove(body: RigidBody) {
    this.world.removeRigidBody(body);
  }

  // oxlint-disable-next-line class-methods-use-this -- part of the PhysicsWorld facade; callers hold the instance, not the class
  makeDynamic(body: RigidBody) {
    body.setBodyType(RigidBodyType.Dynamic, true);
  }

  // oxlint-disable-next-line class-methods-use-this -- part of the PhysicsWorld facade; callers hold the instance, not the class
  makeKinematic(body: RigidBody) {
    body.setBodyType(RigidBodyType.KinematicPositionBased, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  }

  // oxlint-disable-next-line class-methods-use-this -- part of the PhysicsWorld facade; callers hold the instance, not the class
  teleport(body: RigidBody, x: number, y: number, z: number, q: THREE.Quaternion) {
    body.setTranslation({ x, y, z }, false);
    body.setRotation({ w: q.w, x: q.x, y: q.y, z: q.z }, false);
    body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  }

  prewarm() {
    this.world.step();
  }

  /** How far past the last simulated pose the render clock has run, 0..1 of a
   *  fixed step. The renderer sits between the last two poses at this fraction
   *  (Car.captureStep / syncFromPhysics) — without it, a 120Hz display draws
   *  each 60Hz pose twice and everything in the world visibly steps. */
  get alpha() {
    return Math.min(1, this.acc / FIXED_DT);
  }

  step(dt: number, onFixedStep?: (fixedDt: number) => void, onStepped?: () => void) {
    this.acc += dt;
    let steps = 0;

    while (this.acc >= FIXED_DT && steps < MAX_STEPS) {
      onFixedStep?.(FIXED_DT);
      this.world.step();
      onStepped?.();
      this.acc -= FIXED_DT;
      steps += 1;
    }

    if (this.acc >= FIXED_DT) {
      this.acc = 0;
    }
  }
}
