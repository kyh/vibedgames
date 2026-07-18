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
const STATIC_HALF_HEIGHT = 6; // buildings/walls modeled as tall boxes

// Static solids stream in around the taxi instead of living in the world all
// at once: Rapier's step pays a ~linear per-resident-collider cost even when
// nothing moves (measured ~3.4ms/step with all ~32k solids resident — the
// entire mobile frame budget went to an idle broadphase). Everything that can
// bounce off a building (punted traffic, cones, wrecks) lives within ~80u of
// the taxi (traffic stops feeding kinematic targets at BODY_FAR), so only the
// boxes near the player need to be physical. The taxi itself never touches
// these boxes — its arcade collision tests city solids directly.
const SOLID_STREAM_IN = 160; // boxes closer than this become colliders
const SOLID_STREAM_OUT = 200; // resident boxes farther than this are removed
const SOLID_RESTREAM_DIST = 24; // re-scan after the taxi moves this far

type SolidBox = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly yaw: number;
  readonly reach: number; // conservative footprint radius: max(hx, hz)
  collider: RAPIER.Collider | null;
};

export class PhysicsWorld {
  private world: RAPIER.World;
  private acc = 0;
  private solidBoxes: SolidBox[] = [];
  private streamX = Infinity;
  private streamZ = Infinity;

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    return new PhysicsWorld();
  }

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -30, z: 0 });
    this.world.timestep = FIXED_DT;
  }

  // The raw Rapier world — the raycast vehicle builds its controller on it.
  raw(): RAPIER.World {
    return this.world;
  }

  // Ground as a heightfield sampled from the DRIVE surface (city.heightAt:
  // terrain + street depression + pier/bridge decks + park terraces), so the
  // wheels ride exactly what the player sees.
  addGround(heightAt: (x: number, z: number) => number): void {
    const spanX = WORLD_W * 1.06;
    const spanZ = WORLD_H * 1.06;
    const ncols = Math.ceil(spanX / GROUND_SAMPLE); // columns run along X
    const nrows = Math.ceil(spanZ / GROUND_SAMPLE); // rows run along Z
    const heights = new Float32Array((nrows + 1) * (ncols + 1));
    for (let col = 0; col <= ncols; col++) {
      const x = -spanX / 2 + (col / ncols) * spanX;
      for (let row = 0; row <= nrows; row++) {
        const z = -spanZ / 2 + (row / nrows) * spanZ;
        heights[col * (nrows + 1) + row] = heightAt(x, z);
      }
    }
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.heightfield(nrows, ncols, heights, {
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
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(positions, indices).setFriction(0.9),
      body,
    );
  }

  // City solids (buildings, walls, railings) as tall static boxes; rotated
  // solids (avenue-aligned buildings) carry their yaw. Nothing becomes a
  // collider here — boxes are precomputed and streamSolids() keeps only the
  // ones near the taxi resident.
  addStaticSolids(solids: readonly Solid[], terrain: Terrain): void {
    for (const s of solids) {
      if (s.noBody) continue; // tree trunks etc — arcade-collision only
      const cx = (s.minX + s.maxX) / 2;
      const cz = (s.minZ + s.maxZ) / 2;
      if (Math.abs(cx) > WORLD_HALF_X + 30 || Math.abs(cz) > WORLD_HALF_Z + 30) continue;
      const hx = Math.max(0.1, (s.maxX - s.minX) / 2);
      const hz = Math.max(0.1, (s.maxZ - s.minZ) / 2);
      const base = terrain.heightAt(cx, cz);
      // Height-capped solids (maxY — construction barriers etc) get a box of
      // their REAL height: the default tall box walled off any drivable deck
      // above them (a chicane under a freeway ramp blocked the ramp).
      const hy =
        s.maxY !== undefined
          ? Math.min(STATIC_HALF_HEIGHT, Math.max(0.3, (s.maxY - base) / 2))
          : STATIC_HALF_HEIGHT;
      this.solidBoxes.push({
        x: cx,
        y: base + hy - 1,
        z: cz,
        hx,
        hy,
        hz,
        yaw: s.yaw ?? 0,
        reach: Math.max(hx, hz),
        collider: null,
      });
    }
  }

  // Keep the static-solid colliders near (x, z) resident and evict the rest.
  // Call every frame with the taxi position (before step); re-scans only
  // after the taxi moves SOLID_RESTREAM_DIST, and the in/out radii overlap so
  // boxes never flap at a boundary. Inserts/removals are incremental BVH
  // updates — dozens per re-scan, not thousands.
  streamSolids(x: number, z: number): void {
    const moved = Math.hypot(x - this.streamX, z - this.streamZ);
    if (moved < SOLID_RESTREAM_DIST) return;
    this.streamX = x;
    this.streamZ = z;
    for (const box of this.solidBoxes) {
      const d = Math.hypot(x - box.x, z - box.z) - box.reach;
      if (box.collider === null && d < SOLID_STREAM_IN) {
        const desc = RAPIER.ColliderDesc.cuboid(box.hx, box.hy, box.hz)
          .setFriction(0.6)
          .setTranslation(box.x, box.y, box.z);
        if (box.yaw !== 0) {
          desc.setRotation({ x: 0, y: Math.sin(box.yaw / 2), z: 0, w: Math.cos(box.yaw / 2) });
        }
        box.collider = this.world.createCollider(desc);
      } else if (box.collider !== null && d > SOLID_STREAM_OUT) {
        this.world.removeCollider(box.collider, true);
        box.collider = null;
      }
    }
  }

  // A traffic car: kinematic while it follows its route, dynamic once punted.
  // Density gives the punted body real heft (~135kg vs the taxi's 250): a hit
  // transfers real weight — the heavier taxi wins and drives through, but the
  // car resists and shoves aside instead of flinging off like a beach ball.
  // Restitution near zero so it thuds and settles, never pings.
  createCarBody(x: number, y: number, z: number): RAPIER.RigidBody {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(x, y, z)
        .setLinearDamping(1.8)
        .setAngularDamping(1.6),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(1.0, 0.75, 1.25)
        .setFriction(0.7)
        .setRestitution(0.05)
        .setDensity(18),
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
  // makeDynamic() lets it bounce. Yawed to face along its curb. `density`
  // defaults to the normal-play value; the trailer's staged plow row passes a
  // lighter one so a full-speed plow launches cars instead of spinning the taxi.
  createParkedBody(
    x: number,
    y: number,
    z: number,
    yaw: number,
    density = 18,
  ): RAPIER.RigidBody {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(x, y, z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setLinearDamping(1.8)
        .setAngularDamping(1.6),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(1.0, 0.75, 1.25)
        .setFriction(0.7)
        .setRestitution(0.05)
        .setDensity(density),
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

  // Force ONE real step regardless of the fixed-dt accumulator: Rapier
  // builds its broadphase BVH lazily on the first step (~seconds with 20k
  // static colliders) — pay it during load, never on the player's Enter.
  prewarm(): void {
    this.world.step();
  }

  step(dt: number, onFixedStep?: (fixedDt: number) => void): void {
    this.acc += dt;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < MAX_STEPS) {
      // Vehicle suspension/forces run INSIDE the fixed loop so the raycast
      // controller always integrates at FIXED_DT (reference behaviour).
      onFixedStep?.(FIXED_DT);
      this.world.step();
      this.acc -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;
  }
}
