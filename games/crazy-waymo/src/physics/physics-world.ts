import { ColliderDesc, ready, RigidBodyDesc, RigidBodyType, World } from "#rapier";
import type { Collider, RigidBody } from "#rapier";
import type * as THREE from "three";

import { WORLD_H, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W } from "../shared/constants";
import type { Solid } from "../world/city";
import type { Terrain } from "../world/terrain";
import { staticSolidBox, staticSolidCollider } from "./static-solid";
import type { StaticSolidBox } from "./static-solid";

// Rapier owns the player's raycast vehicle, traffic bodies and static scenery.

const FIXED_DT = 1 / 60;
// Per frame; time beyond this is dropped (tab-back spike guard). Phones and
// tablets (coarse pointer) cap at 2: when a frame runs long, catching up with
// extra fixed steps makes the NEXT frame longer still — the classic physics
// spiral. Slight time dilation under load reads far better than a hitch.
const MAX_STEPS = window.matchMedia("(pointer: coarse)").matches ? 2 : 4;
// World units between ground collider samples. The PLAYER rides this surface
// (the raycast vehicle's wheels ray against it), so it must track the
// rendered road: the old 28u trimesh chords deviated up to ~1.5u from the
// draped asphalt on the steep hills — the car floated on slopes and jolted
// on invisible chord ridges mid-street. A heightfield collider (no BVH,
// O(1) queries) makes fine sampling affordable where a trimesh was not.
const GROUND_SAMPLE = 4;

// Static solids stream in around the taxi instead of living in the world all
// at once: Rapier's step pays a ~linear per-resident-collider cost even when
// nothing moves (measured ~3.4ms/step with all ~32k solids resident — the
// entire mobile frame budget went to an idle broadphase). Everything that can
// bounce off a building (punted traffic, cones, wrecks) lives within ~80u of
// the taxi (traffic stops feeding kinematic targets at BODY_FAR), so only the
// boxes near the player need to be physical. NB: this comment used to claim
// "the taxi itself never touches these boxes — its arcade collision tests city
// solids directly", and that is backwards. `car.update` returns at its first
// line into `updatePhysicsControls` whenever a RaycastVehicle is attached —
// i.e. always, in the shipped game — so the arcade `resolveCollisions` is dead
// code and these boxes are the ONLY thing the taxi collides with.
// boxes closer than this become colliders
const SOLID_STREAM_IN = 160;
// resident boxes farther than this are removed
const SOLID_STREAM_OUT = 200;
// re-scan after the taxi moves this far
const SOLID_RESTREAM_DIST = 24;

// Struct-of-arrays: x, y, z, hx, hy, hz, yaw, reach per box. The city holds
// ~250k boxes (every parcel wall), and one object per box was ~35 MB of heap
// on a phone for a table the stream scan only ever reads numerically. The
// parcel walls come and go with their world tile, so boxes live in blocks:
// one for the base city, one per resident tile.
const BOX_STRIDE = 8;
// conservative footprint radius: max(hx, hz)
const BOX_REACH = 7;
const BASE_BLOCK = -1;

interface SolidBlock {
  readonly boxes: Float32Array;
  readonly count: number;
  readonly resident: Map<number, Collider>;
}

const boxAt = (b: Float32Array, i: number): StaticSolidBox => {
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

  static async create(): Promise<PhysicsWorld> {
    await ready();
    return new PhysicsWorld();
  }

  private constructor() {
    this.world = new World({ x: 0, y: -30, z: 0 });
    this.world.timestep = FIXED_DT;
  }

  // The raw Rapier world — the raycast vehicle builds its controller on it.
  raw(): World {
    return this.world;
  }

  // Ground as a heightfield sampled from the DRIVE surface (city.heightAt:
  // terrain + street depression + pier/bridge decks + park terraces), so the
  // wheels ride exactly what the player sees.
  addGround(heightAt: (x: number, z: number) => number): void {
    const spanX = WORLD_W * 1.06;
    const spanZ = WORLD_H * 1.06;
    // columns run along X
    const ncols = Math.ceil(spanX / GROUND_SAMPLE);
    // rows run along Z
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

  // A static triangle soup (the freeway decks + barriers): the raycast
  // vehicle's wheels ride it exactly like the ground heightfield, but because
  // it coexists WITH the heightfield, streets keep working underneath —
  // two-level drivable surfaces the single heightfield cannot express.
  addStaticTrimesh(positions: Float32Array): void {
    const indices = new Uint32Array(positions.length / 3);
    for (let i = 0; i < indices.length; i += 1) {
      indices[i] = i;
    }
    const body = this.world.createRigidBody(RigidBodyDesc.fixed());
    this.world.createCollider(ColliderDesc.trimesh(positions, indices).setFriction(0.9), body);
  }

  // City solids (buildings, walls, railings) as tall static boxes; rotated
  // solids (avenue-aligned buildings) carry their yaw. Nothing becomes a
  // collider here — boxes are precomputed and streamSolids() keeps only the
  // ones near the taxi resident.
  addStaticSolids(solids: readonly Solid[], terrain: Terrain, tile = BASE_BLOCK): void {
    this.removeStaticSolids(tile);
    const boxes = new Float32Array(solids.length * BOX_STRIDE);
    let count = 0;
    for (const s of solids) {
      if (s.noBody) {
        continue;
        // tree trunks etc — arcade-collision only
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
    // A block added mid-drive must stream on the next frame, not after the
    // taxi moves another SOLID_RESTREAM_DIST.
    this.streamX = Infinity;
  }

  /** Drop a tile's boxes, resident colliders included. */
  removeStaticSolids(tile: number): void {
    const block = this.blocks.get(tile);
    if (!block) {
      return;
    }
    for (const collider of block.resident.values()) {
      this.world.removeCollider(collider, true);
    }
    this.blocks.delete(tile);
  }

  // Keep the static-solid colliders near (x, z) resident and evict the rest.
  // Call every frame with the taxi position (before step); re-scans only
  // after the taxi moves SOLID_RESTREAM_DIST, and the in/out radii overlap so
  // boxes never flap at a boundary. Inserts/removals are incremental BVH
  // updates — dozens per re-scan, not thousands.
  streamSolids(x: number, z: number): void {
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

  // A traffic car: kinematic while it follows its route, dynamic once punted.
  // Density gives the punted body real heft (~135kg vs the taxi's 250): a hit
  // transfers real weight — the heavier taxi wins and drives through, but the
  // car resists and shoves aside instead of flinging off like a beach ball.
  // Restitution near zero so it thuds and settles, never pings.
  createCarBody(x: number, y: number, z: number): RigidBody {
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

  // A launched traffic cone: light dynamic cylinder born with its fling velocity.
  createConeBody(x: number, y: number, z: number, vx: number, vy: number, vz: number): RigidBody {
    const body = this.world.createRigidBody(
      RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setLinvel(vx, vy, vz)
        // tumble across travel
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

  // A parked car: kinematic (stays exactly put) until the taxi punts it, then
  // makeDynamic() lets it bounce. Yawed to face along its curb. `density`
  // defaults to the normal-play value; the trailer's staged plow row passes a
  // lighter one so a full-speed plow launches cars instead of spinning the taxi.
  createParkedBody(x: number, y: number, z: number, yaw: number, density = 18): RigidBody {
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

  remove(body: RigidBody): void {
    this.world.removeRigidBody(body);
  }

  // oxlint-disable-next-line class-methods-use-this -- part of the PhysicsWorld facade; callers hold the instance, not the class
  makeDynamic(body: RigidBody): void {
    body.setBodyType(RigidBodyType.Dynamic, true);
  }

  // oxlint-disable-next-line class-methods-use-this -- part of the PhysicsWorld facade; callers hold the instance, not the class
  makeKinematic(body: RigidBody): void {
    body.setBodyType(RigidBodyType.KinematicPositionBased, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  }

  // oxlint-disable-next-line class-methods-use-this -- part of the PhysicsWorld facade; callers hold the instance, not the class
  teleport(body: RigidBody, x: number, y: number, z: number, q: THREE.Quaternion): void {
    body.setTranslation({ x, y, z }, false);
    body.setRotation({ w: q.w, x: q.x, y: q.y, z: q.z }, false);
    body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  }

  // Force ONE real step regardless of the fixed-dt accumulator: Rapier
  // builds its broadphase BVH lazily on the first step (~seconds with 20k
  // static colliders) — pay it during load, never on the player's Enter.
  prewarm(): void {
    this.world.step();
  }

  /** How far past the last simulated pose the render clock has run, 0..1 of a
   *  fixed step. The renderer sits between the last two poses at this fraction
   *  (Car.captureStep / syncFromPhysics) — without it, a 120Hz display draws
   *  each 60Hz pose twice and everything in the world visibly steps. */
  get alpha(): number {
    return Math.min(1, this.acc / FIXED_DT);
  }

  step(dt: number, onFixedStep?: (fixedDt: number) => void, onStepped?: () => void): void {
    this.acc += dt;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < MAX_STEPS) {
      // Vehicle suspension/forces run INSIDE the fixed loop so the raycast
      // controller always integrates at FIXED_DT (reference behaviour).
      onFixedStep?.(FIXED_DT);
      this.world.step();
      onStepped?.();
      this.acc -= FIXED_DT;
      steps += 1;
    }
    if (steps === MAX_STEPS) {
      this.acc = 0;
    }
  }
}
