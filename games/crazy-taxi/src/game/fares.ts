import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { CHARACTERS, modelUrl } from "../assets/manifest";
import { FARE, ROAD_TILE } from "../shared/constants";
import { Rng } from "../shared/rng";
import { type Dir, DIR_DELTA, E, N, S, W } from "../shared/types";
import type { CityModel, RoadCell } from "../world/city";
import type { Car } from "../vehicle/car";
import { parSeconds } from "./state";

// Trip tiers: how far the customer wants to go — pay and beacon color follow.
export type FareTier = "short" | "medium" | "long";

const TIER_COLOR: Record<FareTier, number> = {
  short: 0x6bff8e, // green $
  medium: 0xffb64d, // amber $$
  long: 0xff5d5d, // red $$$
};
const TIER_PAY: Record<FareTier, number> = { short: 1, medium: 1.2, long: 1.5 };
const CARRY_COLOR = 0x49e0ff;

export function tierColor(t: FareTier): number {
  return TIER_COLOR[t];
}
export function tierPayMult(t: FareTier): number {
  return TIER_PAY[t];
}

export type FareEvent =
  | { readonly kind: "none" }
  | {
      readonly kind: "pickup";
      readonly pos: THREE.Vector3;
      readonly tier: FareTier;
      readonly dest: RoadCell;
      readonly tiles: number;
    }
  | {
      readonly kind: "dropoff";
      readonly tiles: number;
      readonly rideTime: number;
      readonly pos: THREE.Vector3;
      readonly tier: FareTier;
    }
  | { readonly kind: "bail"; readonly pos: THREE.Vector3 };

export type Objective = {
  readonly pos: THREE.Vector3;
  readonly kind: "seek" | "carry";
  readonly tiles: number; // trip length when carrying (0 while seeking)
  readonly tier: FareTier;
  readonly patienceFrac: number; // 1 fresh .. 0 bailing (1 while seeking)
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
  setVisible(v: boolean): void {
    this.group.visible = v;
  }
  // Beacons are created per fare — free the GPU resources when one retires.
  dispose(): void {
    this.pillar.geometry.dispose();
    this.ring.geometry.dispose();
    this.mat.dispose();
    this.ringMat.dispose();
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

type WaitingFare = {
  readonly cell: RoadCell;
  readonly pos: THREE.Vector3;
  readonly passenger: THREE.Object3D;
  readonly tier: FareTier;
  readonly beacon: Beacon;
};

type Carrying = {
  readonly from: RoadCell;
  readonly dest: RoadCell;
  readonly pos: THREE.Vector3;
  readonly rideStart: number;
  readonly tiles: number;
  readonly tier: FareTier;
  readonly patienceBudget: number;
};

// A passenger running to the cab (pickup) or walking off (dropoff).
type Extra = {
  readonly node: THREE.Object3D;
  readonly kind: "board" | "leave";
  t: number;
  readonly from: THREE.Vector3;
  readonly dir: THREE.Vector3;
};

export class FareManager {
  readonly group = new THREE.Group();
  private waiting: WaitingFare[] = [];
  private carrying: Carrying | null = null;
  private carryBeacon: Beacon;
  private extras: Extra[] = [];
  private clock = 0;
  private spawnAt = 0; // next waiting-fare top-up time
  private firstSpawn = true;
  private rng: Rng;

  constructor(
    private cache: ModelCache,
    private city: CityModel,
    seed = 7,
  ) {
    this.rng = new Rng(seed);
    this.carryBeacon = new Beacon(CARRY_COLOR);
    this.carryBeacon.setVisible(false);
    this.group.add(this.carryBeacon.group);
  }

  reset(carX: number, carZ: number): void {
    this.clock = 0;
    this.spawnAt = 0;
    this.firstSpawn = true;
    this.carrying = null;
    this.carryBeacon.setVisible(false);
    for (const w of this.waiting) {
      this.group.remove(w.passenger);
      this.group.remove(w.beacon.group);
      w.beacon.dispose();
    }
    for (const e of this.extras) this.group.remove(e.node);
    this.waiting = [];
    this.extras = [];
    const near: RoadCell = { gx: this.city.gridX(carX), gz: this.city.gridZ(carZ) };
    while (this.waiting.length < FARE.waitingFares) this.spawnWaiting(near);
  }

  objective(): Objective | null {
    const c = this.carrying;
    if (c) {
      return {
        pos: c.pos,
        kind: "carry",
        tiles: c.tiles,
        tier: c.tier,
        patienceFrac: this.patienceFrac(),
      };
    }
    let best: WaitingFare | null = null;
    let bd = Infinity;
    for (const w of this.waiting) {
      const d = w.pos.lengthSq(); // caller-relative distance handled by HUD; any stable pick works
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    if (!best) return null;
    return { pos: best.pos, kind: "seek", tiles: 0, tier: best.tier, patienceFrac: 1 };
  }

  // Nearest waiting customer to a world position (arrow + HUD target).
  nearestWaiting(x: number, z: number): WaitingFare | null {
    let best: WaitingFare | null = null;
    let bd = Infinity;
    for (const w of this.waiting) {
      const d = (w.pos.x - x) * (w.pos.x - x) + (w.pos.z - z) * (w.pos.z - z);
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    return best;
  }

  carryingInfo(): Carrying | null {
    return this.carrying;
  }

  // Waiting customers for the minimap.
  waitingList(): readonly { x: number; z: number; tier: FareTier }[] {
    return this.waiting.map((w) => ({ x: w.pos.x, z: w.pos.z, tier: w.tier }));
  }

  patienceFrac(): number {
    const c = this.carrying;
    if (!c) return 1;
    const elapsed = this.clock - c.rideStart;
    return Math.max(0, Math.min(1, 1 - elapsed / c.patienceBudget));
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

  private rollTier(): FareTier {
    const r = this.rng.range(0, 1);
    if (r < 0.45) return "short";
    if (r < 0.8) return "medium";
    return "long";
  }

  private tierRange(t: FareTier): readonly [number, number] {
    if (t === "short") return [4, FARE.tierShortMax];
    if (t === "medium") return [FARE.tierShortMax + 1, FARE.tierMediumMax];
    return [FARE.tierMediumMax + 1, FARE.tierLongMax];
  }

  private spawnWaiting(near: RoadCell): void {
    // The very first customer of a run stands close — the first full loop
    // (pickup → dropoff → $$$ → +time) must land inside ~30 seconds.
    const min = this.firstSpawn ? 3 : 5;
    const max = this.firstSpawn ? FARE.firstSeekMax : 12;
    this.firstSpawn = false;
    const cell = this.pickCell(near, min, max);
    // Don't stack two customers on the same cell.
    if (this.waiting.some((w) => w.cell.gx === cell.gx && w.cell.gz === cell.gz)) {
      return;
    }
    const pos = this.curbPoint(cell);
    const tier = this.rollTier();
    const passenger = this.cache.instance(modelUrl("characters", this.rng.pick(CHARACTERS)));
    const b = this.cache.bounds(modelUrl("characters", CHARACTERS[0]));
    passenger.scale.setScalar(PASSENGER_HEIGHT / Math.max(b.size.y, 0.001));
    passenger.position.copy(pos);
    passenger.rotation.y = this.rng.range(0, Math.PI * 2);
    this.group.add(passenger);
    const beacon = new Beacon(TIER_COLOR[tier]);
    beacon.setPos(pos.x, pos.y, pos.z);
    this.group.add(beacon.group);
    this.waiting.push({ cell, pos, passenger, tier, beacon });
  }

  update(dt: number, car: Car): FareEvent {
    this.clock += dt;
    this.carryBeacon.update(dt);
    for (const w of this.waiting) {
      w.beacon.update(dt);
      w.passenger.position.y = w.pos.y + Math.sin(this.clock * 4 + w.pos.x) * 0.08; // idle bob
    }

    // Passenger theater: run-to-cab boarding + walk-away leaving.
    for (let i = this.extras.length - 1; i >= 0; i--) {
      const e = this.extras[i];
      if (!e) continue;
      e.t += dt;
      if (e.kind === "board") {
        const f = Math.min(1, e.t / 0.45);
        e.node.position.lerpVectors(e.from, car.position, f);
        e.node.scale.setScalar((PASSENGER_HEIGHT / 1) * (1 - f * 0.7) * 0.35);
        if (f >= 1) {
          this.group.remove(e.node);
          this.extras.splice(i, 1);
        }
      } else {
        const f = Math.min(1, e.t / 1.6);
        e.node.position.copy(e.from).addScaledVector(e.dir, f * 4);
        const pop = e.t < 0.25 ? e.t / 0.25 : 1;
        e.node.scale.setScalar(0.35 * pop);
        if (f >= 1) {
          this.group.remove(e.node);
          this.extras.splice(i, 1);
        }
      }
    }

    // Top up the street to the target customer count.
    if (this.waiting.length < FARE.waitingFares && this.clock >= this.spawnAt) {
      this.spawnAt = this.clock + 0.4;
      this.spawnWaiting({ gx: this.city.gridX(car.position.x), gz: this.city.gridZ(car.position.z) });
    }

    const c = this.carrying;
    if (c) {
      // Patience: the passenger bails if the ride drags on far past par.
      if (this.clock - c.rideStart >= c.patienceBudget) {
        this.carrying = null;
        this.carryBeacon.setVisible(false);
        const leavePos = this.curbPoint({
          gx: this.city.gridX(car.position.x),
          gz: this.city.gridZ(car.position.z),
        });
        this.spawnLeaver(leavePos);
        return { kind: "bail", pos: leavePos };
      }
      const dx = car.position.x - c.pos.x;
      const dz = car.position.z - c.pos.z;
      if (dx * dx + dz * dz <= FARE.dropoffRadius * FARE.dropoffRadius) {
        const rideTime = this.clock - c.rideStart;
        this.carrying = null;
        this.carryBeacon.setVisible(false);
        this.spawnLeaver(c.pos);
        return { kind: "dropoff", tiles: c.tiles, rideTime, pos: c.pos.clone(), tier: c.tier };
      }
      return { kind: "none" };
    }

    // Seeking: board the nearest waiting customer inside the pickup radius.
    for (let i = 0; i < this.waiting.length; i++) {
      const w = this.waiting[i];
      if (!w) continue;
      const dx = car.position.x - w.pos.x;
      const dz = car.position.z - w.pos.z;
      if (dx * dx + dz * dz > FARE.pickupRadius * FARE.pickupRadius) continue;
      this.waiting.splice(i, 1);
      this.group.remove(w.beacon.group);
      w.beacon.dispose();
      // The boarding run replaces the idle passenger.
      this.extras.push({
        node: w.passenger,
        kind: "board",
        t: 0,
        from: w.pos.clone(),
        dir: new THREE.Vector3(),
      });
      const [tMin, tMax] = this.tierRange(w.tier);
      const dest = this.pickCell(w.cell, tMin, tMax);
      const pos = this.curbPoint(dest);
      const tiles = this.cellDistance(w.cell, dest);
      this.carryBeacon.setColor(CARRY_COLOR);
      this.carryBeacon.setPos(pos.x, pos.y, pos.z);
      this.carryBeacon.setVisible(true);
      this.carrying = {
        from: w.cell,
        dest,
        pos,
        rideStart: this.clock,
        tiles,
        tier: w.tier,
        patienceBudget: parSeconds(tiles) * FARE.patienceParMult,
      };
      return { kind: "pickup", pos: w.pos.clone(), tier: w.tier, dest, tiles };
    }
    return { kind: "none" };
  }

  private spawnLeaver(at: THREE.Vector3): void {
    const node = this.cache.instance(modelUrl("characters", this.rng.pick(CHARACTERS)));
    node.position.copy(at);
    node.rotation.y = this.rng.range(0, Math.PI * 2);
    const ang = this.rng.range(0, Math.PI * 2);
    this.group.add(node);
    this.extras.push({
      node,
      kind: "leave",
      t: 0,
      from: at.clone(),
      dir: new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang)),
    });
  }
}
