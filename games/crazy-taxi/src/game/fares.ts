import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { CHARACTERS, modelUrl } from "../assets/manifest";
import { FARE, ROAD_TILE } from "../shared/constants";
import { Rng } from "../shared/rng";
import { type Dir, DIR_DELTA, E, N, S, W } from "../shared/types";
import type { CityModel, RoadCell } from "../world/city";
import type { Car } from "../vehicle/car";

export type FareEvent =
  | { readonly kind: "none" }
  | { readonly kind: "pickup"; readonly pos: THREE.Vector3 }
  | {
      readonly kind: "dropoff";
      readonly tiles: number;
      readonly rideTime: number;
      readonly pos: THREE.Vector3;
    };

export type Objective = {
  readonly pos: THREE.Vector3;
  readonly kind: "seek" | "carry";
  readonly tiles: number; // trip length when carrying (0 while seeking)
};

const PASSENGER_HEIGHT = 1.5;

class Beacon {
  readonly group = new THREE.Group();
  private pillar: THREE.Mesh;
  private ring: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private ringMat: THREE.MeshBasicMaterial;
  private t = 0;

  constructor(color: number) {
    this.mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 16, 12, 1, true), this.mat);
    this.pillar.position.y = 8;
    this.group.add(this.pillar);

    this.ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(2.0, 2.5, 28), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.06;
    this.group.add(this.ring);
  }

  setColor(color: number): void {
    this.mat.color.setHex(color);
    this.ringMat.color.setHex(color);
  }
  setPos(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
  }
  update(dt: number): void {
    this.t += dt;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 3);
    this.mat.opacity = 0.2 + pulse * 0.25;
    this.ring.rotation.z += dt * 1.5;
    const rs = 1 + pulse * 0.12;
    this.ring.scale.set(rs, rs, rs);
  }
}

type Phase =
  | { tag: "seek"; cell: RoadCell; pos: THREE.Vector3; passenger: THREE.Object3D }
  | { tag: "carry"; from: RoadCell; dest: RoadCell; pos: THREE.Vector3; rideStart: number }
  | { tag: "respawn"; until: number };

export class FareManager {
  readonly group = new THREE.Group();
  private beacon: Beacon;
  private phase: Phase = { tag: "respawn", until: 0 };
  private clock = 0;
  private rng: Rng;

  constructor(
    private cache: ModelCache,
    private city: CityModel,
    seed = 7,
  ) {
    this.rng = new Rng(seed);
    this.beacon = new Beacon(0x49e0ff);
    this.group.add(this.beacon.group);
  }

  reset(carX: number, carZ: number): void {
    this.clock = 0;
    if (this.phase.tag === "seek") this.group.remove(this.phase.passenger);
    this.spawnSeek(this.city.gridX(carX), this.city.gridZ(carZ));
  }

  objective(): Objective | null {
    if (this.phase.tag === "seek") return { pos: this.phase.pos, kind: "seek", tiles: 0 };
    if (this.phase.tag === "carry")
      return {
        pos: this.phase.pos,
        kind: "carry",
        tiles: this.cellDistance(this.phase.from, this.phase.dest),
      };
    return null;
  }

  private cellDistance(a: RoadCell, b: RoadCell): number {
    return Math.abs(a.gx - b.gx) + Math.abs(a.gz - b.gz);
  }

  private hasLotNeighbor(c: RoadCell): boolean {
    for (const d of [N, E, S, W] as const) {
      const [dx, dz] = DIR_DELTA[d];
      if (this.city.plan.cells[c.gx + dx]?.[c.gz + dz] === "lot") return true;
    }
    return false;
  }

  private pickCell(from: RoadCell, min: number, max: number): RoadCell {
    const cells = this.city.roadCells;
    const inRange = cells.filter((c) => {
      const d = this.cellDistance(from, c);
      return d >= min && d <= max;
    });
    // Prefer cells with a building lot next to them so the fare stands at a real
    // curb, not stranded in the middle of a 4-way intersection.
    const curbside = inRange.filter((c) => this.hasLotNeighbor(c));
    if (curbside.length > 0) return this.rng.pick(curbside);
    if (inRange.length > 0) return this.rng.pick(inRange);
    return this.rng.pick(cells);
  }

  // A point on the sidewalk of a road cell (offset toward an adjacent lot).
  private curbPoint(cell: RoadCell): THREE.Vector3 {
    let dir: Dir = E;
    for (const d of [S, E, N, W] as const) {
      const [dx, dz] = DIR_DELTA[d];
      const gx = cell.gx + dx;
      const gz = cell.gz + dz;
      if (this.city.plan.cells[gx]?.[gz] === "lot") {
        dir = d;
        break;
      }
    }
    const [dx, dz] = DIR_DELTA[dir];
    const off = ROAD_TILE * 0.3;
    const x = this.city.worldX(cell.gx) + dx * off;
    const z = this.city.worldZ(cell.gz) + dz * off;
    return new THREE.Vector3(x, this.city.terrain.heightAt(x, z), z);
  }

  private spawnSeek(gx: number, gz: number): void {
    const near: RoadCell = { gx, gz };
    const cell = this.pickCell(near, 5, 11);
    const pos = this.curbPoint(cell);
    const passenger = this.cache.instance(modelUrl("characters", this.rng.pick(CHARACTERS)));
    const b = this.cache.bounds(modelUrl("characters", CHARACTERS[0]));
    passenger.scale.setScalar(PASSENGER_HEIGHT / Math.max(b.size.y, 0.001));
    passenger.position.copy(pos);
    passenger.rotation.y = this.rng.range(0, Math.PI * 2);
    this.group.add(passenger);
    this.beacon.setColor(0x49e0ff);
    this.beacon.setPos(pos.x, pos.y, pos.z);
    this.phase = { tag: "seek", cell, pos, passenger };
  }

  update(dt: number, car: Car): FareEvent {
    this.clock += dt;
    this.beacon.update(dt);

    if (this.phase.tag === "respawn") {
      if (this.clock >= this.phase.until)
        this.spawnSeek(this.city.gridX(car.position.x), this.city.gridZ(car.position.z));
      return { kind: "none" };
    }

    if (this.phase.tag === "seek") {
      const p = this.phase.passenger;
      p.position.y = this.phase.pos.y + Math.sin(this.clock * 4) * 0.08; // idle bob
      const dx = car.position.x - this.phase.pos.x;
      const dz = car.position.z - this.phase.pos.z;
      if (dx * dx + dz * dz <= FARE.pickupRadius * FARE.pickupRadius) {
        this.group.remove(p);
        const from = this.phase.cell;
        const dest = this.pickCell(from, 5, 14);
        const pos = this.curbPoint(dest);
        this.beacon.setColor(0x6bff8e);
        this.beacon.setPos(pos.x, pos.y, pos.z);
        this.phase = { tag: "carry", from, dest, pos, rideStart: this.clock };
        return { kind: "pickup", pos: this.phase.pos };
      }
      return { kind: "none" };
    }

    // carry
    const dx = car.position.x - this.phase.pos.x;
    const dz = car.position.z - this.phase.pos.z;
    if (dx * dx + dz * dz <= FARE.dropoffRadius * FARE.dropoffRadius) {
      const tiles = this.cellDistance(this.phase.from, this.phase.dest);
      const rideTime = this.clock - this.phase.rideStart;
      const pos = this.phase.pos.clone();
      this.phase = { tag: "respawn", until: this.clock + 0.6 };
      return { kind: "dropoff", tiles, rideTime, pos };
    }
    return { kind: "none" };
  }
}
