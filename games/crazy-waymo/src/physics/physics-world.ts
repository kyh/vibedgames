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
  // solids (avenue-aligned buildings) carry their yaw onto the body.
  async addStaticSolids(solids: readonly Solid[], terrain: Terrain): Promise<void> {
    let lastYield = performance.now();
    for (const s of solids) {
      if (performance.now() - lastYield > 12) {
        // Absorb this slice's inserts into the broadphase NOW: Rapier defers
        // BVH incorporation to the next step, and letting 20k pile up hands
        // the game loop one ~20s rebuild on its first frame.
        this.world.step();
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        lastYield = performance.now();
      }
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
      const desc = RAPIER.RigidBodyDesc.fixed().setTranslation(cx, base + hy - 1, cz);
      const yaw = s.yaw ?? 0;
      if (yaw !== 0) {
        desc.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
      }
      const body = this.world.createRigidBody(desc);
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.6), body);
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
  // makeDynamic() lets it bounce. Yawed to face along its curb.
  createParkedBody(x: number, y: number, z: number, yaw: number): RAPIER.RigidBody {
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
        .setDensity(18),
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
