import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl, POLICE_CAR, SERVICE_CARS, TRAFFIC_CARS } from "../assets/manifest";
import { ROAD_TILE, ROAD_Y, TRAFFIC } from "../shared/constants";
import { Rng } from "../shared/rng";
import { type Dir, DIR_DELTA } from "../shared/types";
import type { CityModel, RoadCell } from "../world/city";
import { type DistrictChar, districtAt } from "../world/sf-map";
import { slopeQuaternion } from "../world/terrain";

const MODEL_YAW_OFFSET = 0; // Kenney cars face +Z; no offset (π drives rear-first)
const ALL_DIRS: readonly Dir[] = [0, 1, 2, 3];
const SCRATCH_N = new THREE.Vector3();
const OPPOSITE: Record<Dir, Dir> = { 0: 2, 1: 3, 2: 0, 3: 1 };

// --- Tunables (module-local; TRAFFIC in constants.ts holds count/speeds) ---
// Recycling: keep TRAFFIC.count cars, but teleport far-away ones ahead of the
// player so the streets stay busy without raising the car count.
const RECYCLE_TILES = 20; // Manhattan grid distance beyond which a car recycles
const RESPAWN_MIN_TILES = 6; // respawn ring, inclusive
const RESPAWN_MAX_TILES = 12;
const RESPAWN_GUARD_TILES = 4; // last-resort fallback: never this close to the player
// Vehicle mix (fractions of TRAFFIC.count, assigned deterministically by index).
const POLICE_SHARE = 0.08;
const SERVICE_SHARE = 0.14; // civilians take the remaining ~78%
const POLICE_SPEED_MULT = 1.25;
// Player reaction: brake + honk when the taxi bears down from ahead.
const REACT_RADIUS = 8; // world units
const REACT_DOT = 0.5; // cos threshold: travel dir vs. direction to the player
const BRAKE_FACTOR = 0.35; // speed multiplier while braking
const BRAKE_DURATION = 1.0; // seconds of braking after the last trigger
const HONK_COOLDOWN = 2.5; // seconds between honks per car

export type VehicleKind = "civilian" | "service" | "police";

// District spawn weight ×2 so "park ×0.5" stays an integer repeat count:
// downtown/highrise/commercial ×3, wharf ×2, res/victorian/industrial ×1, park ×0.5.
function districtSpawnWeight(c: DistrictChar): number {
  switch (c) {
    case "downtown":
    case "highrise":
    case "commercial":
      return 6;
    case "wharf":
      return 4;
    case "residential":
    case "victorian":
    case "industrial":
      return 2;
    case "park":
      return 1;
  }
}

export class TrafficCar {
  readonly object3D: THREE.Object3D;
  readonly kind: VehicleKind;
  readonly position = new THREE.Vector3();
  readonly radius = 1.35;
  hitCooldown = 0;
  missCooldown = 0;
  // Set on the brake-reaction rising edge; the game scene consumes it (plays a
  // honk) and clears it. Rate-limited to one honk per HONK_COOLDOWN per car.
  wantsHonk = false;
  private gx: number;
  private gz: number;
  private dir: Dir;
  private t = 0;
  private readonly baseSpeed: number;
  private brakeTimer = 0;
  private honkCooldown = 0;
  private yaw = 0;

  constructor(
    object3D: THREE.Object3D,
    kind: VehicleKind,
    start: RoadCell,
    dir: Dir,
    speed: number,
  ) {
    this.object3D = object3D;
    this.kind = kind;
    this.gx = start.gx;
    this.gz = start.gz;
    this.dir = dir;
    this.baseSpeed = speed;
  }

  respawn(cell: RoadCell, dir: Dir): void {
    this.gx = cell.gx;
    this.gz = cell.gz;
    this.dir = dir;
    this.t = 0;
    this.hitCooldown = 0;
    this.missCooldown = 0;
    this.brakeTimer = 0;
    this.honkCooldown = 0;
    this.wantsHonk = false;
  }

  private isRoad(city: CityModel, gx: number, gz: number): boolean {
    return city.plan.cells[gx]?.[gz] === "road";
  }

  private chooseDir(city: CityModel, rng: Rng): void {
    const reverse = OPPOSITE[this.dir];
    const opts: Dir[] = [];
    for (const d of [0, 1, 2, 3] as const) {
      const [dx, dz] = DIR_DELTA[d];
      if (this.isRoad(city, this.gx + dx, this.gz + dz)) opts.push(d);
    }
    const forward = opts.filter((d) => d !== reverse);
    if (forward.length === 0) {
      this.dir = reverse;
      return;
    }
    if (forward.includes(this.dir) && rng.chance(0.62)) return; // keep going straight
    this.dir = rng.pick(forward);
  }

  update(dt: number, city: CityModel, rng: Rng, playerX: number, playerZ: number): void {
    if (this.hitCooldown > 0) this.hitCooldown -= dt;
    if (this.missCooldown > 0) this.missCooldown -= dt;
    if (this.honkCooldown > 0) this.honkCooldown -= dt;

    // --- Player reaction: taxi close AND roughly ahead → brake, honk once ---
    if (dt > 0) {
      const dx = playerX - this.position.x;
      const dz = playerZ - this.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > 1e-6 && distSq < REACT_RADIUS * REACT_RADIUS) {
        const [fdx, fdz] = DIR_DELTA[this.dir];
        if (fdx * dx + fdz * dz > REACT_DOT * Math.sqrt(distSq)) {
          if (this.brakeTimer <= 0 && this.honkCooldown <= 0) {
            this.wantsHonk = true; // rising edge only, cooldown-gated
            this.honkCooldown = HONK_COOLDOWN;
          }
          this.brakeTimer = BRAKE_DURATION;
        }
      }
      if (this.brakeTimer > 0) this.brakeTimer -= dt;
    }

    const speed = this.brakeTimer > 0 ? this.baseSpeed * BRAKE_FACTOR : this.baseSpeed;
    this.t += (speed * dt) / ROAD_TILE;
    while (this.t >= 1) {
      this.t -= 1;
      const [dx, dz] = DIR_DELTA[this.dir];
      this.gx += dx;
      this.gz += dz;
      this.chooseDir(city, rng);
    }

    const [ndx, ndz] = DIR_DELTA[this.dir];
    const cx = city.worldX(this.gx);
    const cz = city.worldZ(this.gz);
    // Drive slightly to the right of lane center so the player has room.
    const laneX = -ndz * ROAD_TILE * 0.12;
    const laneZ = ndx * ROAD_TILE * 0.12;
    const px = cx + ndx * ROAD_TILE * this.t + laneX;
    const pz = cz + ndz * ROAD_TILE * this.t + laneZ;
    this.position.set(px, city.terrain.heightAt(px, pz) + ROAD_Y, pz);
    this.object3D.position.copy(this.position);

    const targetYaw = Math.atan2(ndx, ndz) + MODEL_YAW_OFFSET;
    let d = ((targetYaw - this.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, dt * 8);
    const n = city.terrain.normalInto(SCRATCH_N, px, pz);
    slopeQuaternion(this.object3D.quaternion, this.yaw, n);
  }
}

export type TrafficOpts = { seed?: number; avoid?: RoadCell; avoidR?: number };

export class Traffic {
  readonly group = new THREE.Group();
  readonly cars: TrafficCar[] = [];
  private rng: Rng;

  private city: CityModel;
  // Road cells repeated by district weight — built once, sampled by index so
  // spawn/respawn picks are district-weighted with zero per-pick allocation.
  private readonly weightedCells: RoadCell[] = [];
  private readonly industrialCells: RoadCell[] = []; // garbage-truck home turf

  constructor(cache: ModelCache, city: CityModel, opts: TrafficOpts = {}) {
    this.city = city;
    this.rng = new Rng(opts.seed ?? 99);

    for (const cell of city.roadCells) {
      const character = districtAt(cell.gx, cell.gz).character;
      const w = districtSpawnWeight(character);
      for (let i = 0; i < w; i++) this.weightedCells.push(cell);
      if (character === "industrial") this.industrialCells.push(cell);
    }

    const avoid = opts.avoid;
    const avoidR = opts.avoidR ?? 4;
    const count = TRAFFIC.count;
    for (let i = 0; i < count && this.weightedCells.length > 0; i++) {
      // Deterministic mix by index: ~8% police, ~14% service, rest civilian.
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
      // Garbage trucks prefer industrial streets when the map offers them.
      const pool =
        model === "garbage-truck" && this.industrialCells.length > 0
          ? this.industrialCells
          : this.weightedCells;
      const cell =
        this.pickCell(
          pool,
          avoid?.gx ?? 0,
          avoid?.gz ?? 0,
          avoid ? avoidR : -1,
          Infinity,
          0,
          0,
          false,
        ) ??
        this.pickCell(
          this.weightedCells,
          avoid?.gx ?? 0,
          avoid?.gz ?? 0,
          avoid ? avoidR : -1,
          Infinity,
          0,
          0,
          false,
        );
      if (!cell) break;
      const obj = cache.instance(modelUrl("cars", model));
      this.group.add(obj);
      const dir = this.rng.pick(ALL_DIRS);
      const speed =
        this.rng.range(TRAFFIC.minSpeed, TRAFFIC.maxSpeed) *
        (kind === "police" ? POLICE_SPEED_MULT : 1);
      const car = new TrafficCar(obj, kind, cell, dir, speed);
      car.update(0, city, this.rng, 0, 0); // place it (dt=0 skips reaction)
      this.cars.push(car);
    }
  }

  // Pick a random cell from `pool` whose Manhattan grid distance to (pgx, pgz)
  // is in (minExcl, maxIncl], optionally restricted to the (hx, hz) forward
  // half-plane. Two passes (count, then select) — no allocation.
  private pickCell(
    pool: readonly RoadCell[],
    pgx: number,
    pgz: number,
    minExcl: number,
    maxIncl: number,
    hx: number,
    hz: number,
    forwardOnly: boolean,
  ): RoadCell | undefined {
    let count = 0;
    for (const c of pool) {
      if (this.cellOk(c, pgx, pgz, minExcl, maxIncl, hx, hz, forwardOnly)) count++;
    }
    if (count === 0) return undefined;
    let k = this.rng.int(count);
    for (const c of pool) {
      if (!this.cellOk(c, pgx, pgz, minExcl, maxIncl, hx, hz, forwardOnly)) continue;
      if (k === 0) return c;
      k--;
    }
    return undefined;
  }

  private cellOk(
    c: RoadCell,
    pgx: number,
    pgz: number,
    minExcl: number,
    maxIncl: number,
    hx: number,
    hz: number,
    forwardOnly: boolean,
  ): boolean {
    const dgx = c.gx - pgx;
    const dgz = c.gz - pgz;
    const d = Math.abs(dgx) + Math.abs(dgz);
    if (d <= minExcl || d > maxIncl) return false;
    return !forwardOnly || dgx * hx + dgz * hz > 0;
  }

  // Respawn target for a recycled car: a road cell 6–12 tiles ahead of the
  // player; else any cell in that ring; else anywhere clear of the player.
  private respawnCell(pgx: number, pgz: number, hx: number, hz: number): RoadCell | undefined {
    return (
      this.pickCell(
        this.weightedCells,
        pgx,
        pgz,
        RESPAWN_MIN_TILES - 1,
        RESPAWN_MAX_TILES,
        hx,
        hz,
        true,
      ) ??
      this.pickCell(
        this.weightedCells,
        pgx,
        pgz,
        RESPAWN_MIN_TILES - 1,
        RESPAWN_MAX_TILES,
        hx,
        hz,
        false,
      ) ??
      this.pickCell(this.weightedCells, pgx, pgz, RESPAWN_GUARD_TILES, Infinity, hx, hz, false)
    );
  }

  // Scatter traffic back across the map, clear of the player's spawn, so a
  // restart never drops the taxi on top of a car.
  reset(avoid?: RoadCell, avoidR = 4): void {
    if (this.weightedCells.length === 0) return;
    for (const c of this.cars) {
      const cell = avoid
        ? (this.pickCell(this.weightedCells, avoid.gx, avoid.gz, avoidR, Infinity, 0, 0, false) ??
          this.rng.pick(this.weightedCells))
        : this.rng.pick(this.weightedCells);
      c.respawn(cell, this.rng.pick(ALL_DIRS));
      c.update(0, this.city, this.rng, 0, 0);
    }
  }

  // Player heading: forward = (sin h, cos h) in XZ. Cars that drift beyond
  // RECYCLE_TILES are teleported into the ring ahead of the player, keeping
  // streets busy at a constant car count.
  update(
    dt: number,
    city: CityModel,
    playerX: number,
    playerZ: number,
    playerHeading: number,
  ): void {
    const pgx = city.gridX(playerX);
    const pgz = city.gridZ(playerZ);
    const hx = Math.sin(playerHeading);
    const hz = Math.cos(playerHeading);
    for (const c of this.cars) {
      const d = Math.abs(city.gridX(c.position.x) - pgx) + Math.abs(city.gridZ(c.position.z) - pgz);
      if (d > RECYCLE_TILES) {
        const cell = this.respawnCell(pgx, pgz, hx, hz);
        if (cell) c.respawn(cell, this.rng.pick(ALL_DIRS));
      }
      c.update(dt, city, this.rng, playerX, playerZ);
    }
  }
}
