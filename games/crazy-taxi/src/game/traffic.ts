import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl, TRAFFIC_CARS } from "../assets/manifest";
import { ROAD_TILE, ROAD_Y, TRAFFIC } from "../shared/constants";
import { Rng } from "../shared/rng";
import { type Dir, DIR_DELTA } from "../shared/types";
import type { CityModel, RoadCell } from "../world/city";

const MODEL_YAW_OFFSET = Math.PI;
const ALL_DIRS: readonly Dir[] = [0, 1, 2, 3];
const OPPOSITE: Record<Dir, Dir> = { 0: 2, 1: 3, 2: 0, 3: 1 };

export class TrafficCar {
  readonly object3D: THREE.Object3D;
  readonly position = new THREE.Vector3();
  readonly radius = 1.35;
  hitCooldown = 0;
  missCooldown = 0;
  private gx: number;
  private gz: number;
  private dir: Dir;
  private t = 0;
  private speed: number;
  private yaw = 0;

  constructor(object3D: THREE.Object3D, start: RoadCell, dir: Dir, speed: number) {
    this.object3D = object3D;
    this.gx = start.gx;
    this.gz = start.gz;
    this.dir = dir;
    this.speed = speed;
  }

  respawn(cell: RoadCell, dir: Dir): void {
    this.gx = cell.gx;
    this.gz = cell.gz;
    this.dir = dir;
    this.t = 0;
    this.hitCooldown = 0;
    this.missCooldown = 0;
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

  update(dt: number, city: CityModel, rng: Rng): void {
    if (this.hitCooldown > 0) this.hitCooldown -= dt;
    if (this.missCooldown > 0) this.missCooldown -= dt;

    this.t += (this.speed * dt) / ROAD_TILE;
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
    this.position.set(
      cx + ndx * ROAD_TILE * this.t + laneX,
      ROAD_Y,
      cz + ndz * ROAD_TILE * this.t + laneZ,
    );
    this.object3D.position.copy(this.position);

    const targetYaw = Math.atan2(ndx, ndz) + MODEL_YAW_OFFSET;
    let d = ((targetYaw - this.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, dt * 8);
    this.object3D.rotation.y = this.yaw;
  }
}

export type TrafficOpts = { seed?: number; avoid?: RoadCell; avoidR?: number };

export class Traffic {
  readonly group = new THREE.Group();
  readonly cars: TrafficCar[] = [];
  private rng: Rng;

  private city: CityModel;

  constructor(cache: ModelCache, city: CityModel, opts: TrafficOpts = {}) {
    this.city = city;
    this.rng = new Rng(opts.seed ?? 99);
    const roads = this.spawnCells(opts.avoid, opts.avoidR ?? 4);
    for (let i = 0; i < TRAFFIC.count && roads.length > 0; i++) {
      const cell = this.rng.pick(roads);
      const model = this.rng.pick(TRAFFIC_CARS);
      const obj = cache.instance(modelUrl("cars", model));
      this.group.add(obj);
      const dir = this.rng.pick(ALL_DIRS);
      const speed = this.rng.range(TRAFFIC.minSpeed, TRAFFIC.maxSpeed);
      const car = new TrafficCar(obj, cell, dir, speed);
      car.update(0, city, this.rng); // place it
      this.cars.push(car);
    }
  }

  private spawnCells(avoid: RoadCell | undefined, avoidR: number): RoadCell[] {
    return avoid
      ? this.city.roadCells.filter(
          (c) => Math.abs(c.gx - avoid.gx) + Math.abs(c.gz - avoid.gz) > avoidR,
        )
      : this.city.roadCells.slice();
  }

  // Scatter traffic back across the map, clear of the player's spawn, so a
  // restart never drops the taxi on top of a car.
  reset(avoid?: RoadCell, avoidR = 4): void {
    const roads = this.spawnCells(avoid, avoidR);
    if (roads.length === 0) return;
    for (const c of this.cars) {
      c.respawn(this.rng.pick(roads), this.rng.pick(ALL_DIRS));
      c.update(0, this.city, this.rng);
    }
  }

  update(dt: number, city: CityModel): void {
    for (const c of this.cars) c.update(dt, city, this.rng);
  }
}
