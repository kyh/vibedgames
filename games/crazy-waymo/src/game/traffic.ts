import * as THREE from "three";

import { geoLayoutKey } from "../assets/loader";
import type { ModelCache } from "../assets/loader";
import { modelUrl, POLICE_CAR, SERVICE_CARS, TRAFFIC_CARS } from "../assets/manifest";
import type { PhysicsWorld } from "../physics/physics-world";
import { CAMERA, ROAD_TILE, TRAFFIC } from "../shared/constants";
import { Rng } from "../shared/rng";
import type { CityModel, RoadCell } from "../world/city";
import type { NetEdge, RoadNetwork } from "../world/network";
import { districtAt } from "../world/sf-map";
import type { DistrictChar } from "../world/sf-map";
import { BODY_LIFT, TrafficCar } from "./traffic-car";
import type { FleetPart, VehicleKind } from "./traffic-car";

// Traffic drives the vector road NETWORK directly: each car is (edge,
// arclength, direction, lane offset). At a junction it hands off through a
// short quadratic bezier around the node — real cornering — onto the next
// edge, chosen with a keep-straight bias. There is no grid in this file.

// beyond this, teleport ahead of the player
const RECYCLE_DIST = ROAD_TILE * 20;
const RESPAWN_MIN = ROAD_TILE * 6;
const RESPAWN_MAX = ROAD_TILE * 12;
// last resort: never this close
const RESPAWN_GUARD = ROAD_TILE * 4;
// A recycle is a teleport, so both ends of it must be off camera: fog starts
// ~360u out and the draw distance is 760, so a car that lands anywhere inside
// the recycle radius and inside the view cone is watched blinking into
// existence (or out of it). The cone is measured at the camera's own spot —
// CAMERA.distance behind the car — and 60 degrees is the horizontal half-FOV
// at CAMERA.fovBoost out to a 21:9 window. The rig's drift swing can push the
// real cone another ~34 degrees to one side mid-slide; padding for that would
// swallow the side wedge entirely and leave respawns nowhere but straight
// behind the player, which drains the streets ahead of traffic.
const VIEW_HALF_ANGLE = Math.PI / 3;
const VIEW_COS = Math.cos(VIEW_HALF_ANGLE);
const POLICE_SHARE = 0.08;
const SERVICE_SHARE = 0.14;
const POLICE_SPEED_MULT = 1.25;

const WRECK_RESPAWN_S = 7;

// On screen for the chase camera (see VIEW_HALF_ANGLE). (hx, hz) is the
// player's heading; the cone apex sits CAMERA.distance behind them.
const inPlayerView = (
  x: number,
  z: number,
  playerX: number,
  playerZ: number,
  hx: number,
  hz: number,
): boolean => {
  const dx = x - (playerX - hx * CAMERA.distance);
  const dz = z - (playerZ - hz * CAMERA.distance);
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) {
    return true;
  }
  return (dx * hx + dz * hz) / d > VIEW_COS;
};

interface TemplatePart {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  local: THREE.Matrix4;
}

const bucketKey = (p: TemplatePart): string => `${p.mat.uuid}|${geoLayoutKey(p.geo)}`;

// A table rather than a switch: the `satisfies` keeps it exhaustive over
// DistrictChar, where a switch would need an unreachable default.
const DISTRICT_SPAWN_WEIGHT = {
  commercial: 6,
  downtown: 6,
  highrise: 6,
  industrial: 2,
  park: 1,
  residential: 2,
  victorian: 2,
  wharf: 4,
} satisfies Record<DistrictChar, number>;

const districtSpawnWeight = (c: DistrictChar): number => DISTRICT_SPAWN_WEIGHT[c];

export interface TrafficOpts {
  seed?: number;
  avoid?: RoadCell;
  avoidR?: number;
}

export class Traffic {
  readonly group = new THREE.Group();
  readonly cars: TrafficCar[] = [];
  private rng: Rng;
  // signal-cycle clock (accumulated dt)
  private simTime = 0;
  // Junction claims: node -> the car currently crossing it (+ claim time).
  private readonly nodeClaims = new Map<number, { car: TrafficCar; t: number }>();
  /** Traffic sim clock — feeds the signal-lamp FX so lights match behavior. */
  get time(): number {
    return this.simTime;
  }
  private city: CityModel;
  private network: RoadNetwork;
  private physics: PhysicsWorld | null;
  // Fleet batches: the whole 52-car fleet renders as one BatchedMesh per
  // (material, attribute layout) — same pattern as ParkedCars — instead of
  // 52 GLB clone subtrees (~6 meshes each ≈ 300+ draws).
  private readonly fleetBatches: THREE.BatchedMesh[] = [];
  // Edges repeated by district weight — random index = district-weighted pick.
  private readonly weightedEdges: NetEdge[] = [];

  constructor(
    cache: ModelCache,
    city: CityModel,
    opts: TrafficOpts = {},
    physics: PhysicsWorld | null = null,
  ) {
    this.physics = physics;
    this.city = city;
    this.network = city.network;
    this.rng = new Rng(opts.seed ?? 99);

    for (const e of this.network.edges) {
      if (e.len < ROAD_TILE) {
        continue;
      }
      const mid = this.network.sample(e, e.len / 2);
      const w = districtSpawnWeight(districtAt(city.gridX(mid.x), city.gridZ(mid.z)).character);
      for (let i = 0; i < w; i += 1) {
        this.weightedEdges.push(e);
      }
    }

    const { avoid } = opts;
    const avoidR = (opts.avoidR ?? 4) * ROAD_TILE;
    const ax = avoid ? city.worldX(avoid.gx) : 0;
    const az = avoid ? city.worldZ(avoid.gz) : 0;
    const { count } = TRAFFIC;
    const fleet: { car: TrafficCar; model: string }[] = [];
    for (let i = 0; i < count && this.weightedEdges.length > 0; i += 1) {
      let kind: VehicleKind;
      let model: string;
      if (i < count * POLICE_SHARE) {
        kind = "police";
        model = POLICE_CAR;
      } else if (i < count * (POLICE_SHARE + SERVICE_SHARE)) {
        kind = "service";
        model = this.rng.pick(SERVICE_CARS);
      } else {
        kind = "civilian";
        model = this.rng.pick(TRAFFIC_CARS);
      }
      const spot = this.pickSpot((x, z) => {
        if (avoid && Math.hypot(x - ax, z - az) < avoidR) {
          return false;
        }
        return this.clearOfCars(x, z, null);
      });
      if (!spot) {
        break;
      }
      // Bare anchor: pose target for the sim, world anchor for speech bubbles.
      // The visible car lives in the fleet batches built below.
      const obj = new THREE.Object3D();
      this.group.add(obj);
      const speed =
        this.rng.range(TRAFFIC.minSpeed, TRAFFIC.maxSpeed) *
        (kind === "police" ? POLICE_SPEED_MULT : 1);
      const car = new TrafficCar(
        obj,
        kind,
        spot.edge,
        spot.s,
        spot.dir,
        speed,
        this.network,
        this.rng,
        this.nodeClaims,
      );
      car.update(0, city, 0, 0);
      if (this.physics) {
        car.body = this.physics.createCarBody(
          car.position.x,
          car.position.y + BODY_LIFT,
          car.position.z,
        );
      }
      this.cars.push(car);
      fleet.push({ car, model });
    }
    this.buildFleetBatches(cache, fleet);
  }

  // Batch the fleet's meshes per (material, attribute layout), one instance
  // slot per (car, model part); cars re-stamp their slots each update.
  private buildFleetBatches(
    cache: ModelCache,
    fleet: readonly { car: TrafficCar; model: string }[],
  ): void {
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
    for (const f of fleet) {
      for (const p of partsOf(f.model)) {
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
      batch.receiveShadow = true;
      // per-instance culling stays on inside
      batch.frustumCulled = false;
      b.batch = batch;
      b.geoIds = new Map();
      this.group.add(batch);
      this.fleetBatches.push(batch);
    }

    for (const f of fleet) {
      const parts: FleetPart[] = [];
      for (const p of partsOf(f.model)) {
        const b = buckets.get(bucketKey(p));
        if (!b || !b.batch || !b.geoIds) {
          continue;
        }
        let gid = b.geoIds.get(p.geo);
        if (gid === undefined) {
          gid = b.batch.addGeometry(p.geo);
          b.geoIds.set(p.geo, gid);
        }
        parts.push({ batch: b.batch, instanceId: b.batch.addInstance(gid), local: p.local });
      }
      f.car.attachParts(parts);
    }
  }

  // Free the fleet's GPU buffers (editor street rebuilds replace Traffic).
  dispose(): void {
    for (const b of this.fleetBatches) {
      b.dispose();
    }
  }

  // Random district-weighted edge spot passing `ok` (bounded retries).
  private pickSpot(
    ok: (x: number, z: number) => boolean,
  ): { edge: NetEdge; s: number; dir: 1 | -1; x: number; z: number } | null {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const edge = this.weightedEdges[this.rng.int(this.weightedEdges.length)];
      if (!edge) {
        continue;
      }
      const s = this.rng.range(edge.len * 0.2, edge.len * 0.8);
      const smp = this.network.sample(edge, s);
      if (!ok(smp.x, smp.z)) {
        continue;
      }
      return { dir: this.rng.chance(0.5) ? 1 : -1, edge, s, x: smp.x, z: smp.z };
    }
    return null;
  }

  private clearOfCars(x: number, z: number, self: TrafficCar | null): boolean {
    for (const c of this.cars) {
      if (c === self) {
        continue;
      }
      if (Math.hypot(c.position.x - x, c.position.z - z) < ROAD_TILE * 1.5) {
        return false;
      }
    }
    return true;
  }

  // Scatter traffic back across the map, clear of the player's spawn.
  reset(avoid?: RoadCell, avoidR = 4): void {
    const ax = avoid ? this.city.worldX(avoid.gx) : 0;
    const az = avoid ? this.city.worldZ(avoid.gz) : 0;
    const r = avoidR * ROAD_TILE;
    for (const c of this.cars) {
      const spot = this.pickSpot((x, z) => {
        if (avoid && Math.hypot(x - ax, z - az) < r) {
          return false;
        }
        return this.clearOfCars(x, z, c);
      });
      if (!spot) {
        continue;
      }
      c.respawn(spot.edge, spot.s, spot.dir);
      c.update(0, this.city, 0, 0);
      this.restoreBody(c);
    }
  }

  /** TRAILER (src/trailer/): freeze the far-car recycler. Staged scenes place
   *  the fleet by hand; the recycler otherwise teleports every far car into a
   *  ring 78-156u AHEAD of the player — a random punt in the framed lane
   *  mid-shot. Normal play never sets this. */
  setHoldRecycle(on: boolean): void {
    this.holdRecycle = on;
  }

  private holdRecycle = false;

  /** TRAILER (src/trailer/): deterministically place one fleet car on an edge
   *  — respawn + pose + kinematic body restored under it (the same pieces the
   *  recycler composes). Normal play never calls this. */
  placeCar(car: TrafficCar, edge: NetEdge, s: number, dir: 1 | -1): void {
    car.respawn(edge, s, dir);
    car.update(0, this.city, 0, 0);
    this.restoreBody(car);
  }

  private restoreBody(c: TrafficCar): void {
    if (!c.body || !this.physics) {
      return;
    }
    this.physics.makeKinematic(c.body);
    this.physics.teleport(
      c.body,
      c.position.x,
      c.position.y + BODY_LIFT,
      c.position.z,
      c.object3D.quaternion,
    );
    // the teleport just put the body back under the car
    c.bodyParked = false;
  }

  update(
    dt: number,
    city: CityModel,
    playerX: number,
    playerZ: number,
    playerHeading: number,
  ): void {
    const hx = Math.sin(playerHeading);
    const hz = Math.cos(playerHeading);
    this.simTime += dt;

    this.applyCarFollowing();

    this.recycleAndStep(dt, city, playerX, playerZ, hx, hz);
  }

  // Car-following separation: hold behind a same-direction car (or a wreck)
  // ahead in the same lane. Coincident pairs brake exactly one by index.
  private applyCarFollowing(): void {
    for (const c of this.cars) {
      c.followFactor = 1;
    }
    for (let i = 0; i < this.cars.length; i += 1) {
      const a = this.cars[i];
      if (!a || a.wrecked) {
        continue;
      }
      for (let j = 0; j < this.cars.length; j += 1) {
        const b = this.cars[j];
        if (!b || a === b) {
          continue;
        }
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const ahead = dx * a.tanX + dz * a.tanZ;
        if (ahead > 7) {
          continue;
        }
        if (ahead < 0.5) {
          if (Math.hypot(dx, dz) < 2 && i > j) {
            a.followFactor = 0;
          }
          continue;
        }
        const lat = Math.abs(-dx * a.tanZ + dz * a.tanX);
        if (lat > 2.2) {
          continue;
        }
        if (!b.wrecked && b.tanX * a.tanX + b.tanZ * a.tanZ < 0.3) {
          continue;
        }
        a.followFactor = Math.min(a.followFactor, ahead < 3.5 ? 0 : 0.45);
      }
    }
  }

  private recycleAndStep(
    dt: number,
    city: CityModel,
    playerX: number,
    playerZ: number,
    hx: number,
    hz: number,
  ): void {
    for (const c of this.cars) {
      const d = Math.hypot(c.position.x - playerX, c.position.z - playerZ);
      const recycleWreck = c.wrecked && c.wreckTime > WRECK_RESPAWN_S;
      const onCamera = inPlayerView(c.position.x, c.position.z, playerX, playerZ, hx, hz);
      if (!this.holdRecycle && !onCamera && (d > RECYCLE_DIST || recycleWreck)) {
        // Respawn in a ring ahead of the player but out of shot — the wedge
        // down a side street or around the corner. Fallback: anywhere off
        // camera inside the recycle radius, so a car can never land beyond
        // the distance that would recycle it straight back.
        const spot =
          this.pickSpot((x, z) => {
            const dist = Math.hypot(x - playerX, z - playerZ);
            if (dist < RESPAWN_MIN || dist > RESPAWN_MAX) {
              return false;
            }
            if ((x - playerX) * hx + (z - playerZ) * hz < 0) {
              return false;
            }
            if (inPlayerView(x, z, playerX, playerZ, hx, hz)) {
              return false;
            }
            return this.clearOfCars(x, z, c);
          }) ??
          this.pickSpot((x, z) => {
            const dist = Math.hypot(x - playerX, z - playerZ);
            if (dist <= RESPAWN_GUARD || dist >= RECYCLE_DIST) {
              return false;
            }
            if (inPlayerView(x, z, playerX, playerZ, hx, hz)) {
              return false;
            }
            return this.clearOfCars(x, z, c);
          });
        if (spot) {
          c.respawn(spot.edge, spot.s, spot.dir);
          c.update(0, city, 0, 0);
          this.restoreBody(c);
        }
      }
      c.update(dt, city, playerX, playerZ, this.physics, this.simTime);
    }
  }

  syncWrecked(): void {
    for (const c of this.cars) {
      c.syncFromBody();
    }
  }
}
