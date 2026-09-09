import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { CHARACTERS, modelUrl } from "../assets/manifest";
import { FARE, ROAD_TILE } from "../shared/constants";
import { Rng } from "../shared/rng";
import { DIR_DELTA, E, N, S, W } from "../shared/types";
import type { Dir } from "../shared/types";
import type { CityModel, RoadCell } from "../world/city";
import type { Car } from "../vehicle/car";
import { Beacon } from "./beacon";
import { tierColor } from "./fare-tier";
import type { FareTier } from "./fare-tier";
import { parSeconds } from "./state";

export { GROUND_RING_LIFT, tierColor, tierPayMult } from "./fare-tier";
export type { FareTier } from "./fare-tier";

const CARRY_COLOR = 0x49_e0_ff;

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

export interface Objective {
  readonly pos: THREE.Vector3;
  readonly kind: "seek" | "carry";
  // trip length when carrying (0 while seeking)
  readonly tiles: number;
  readonly tier: FareTier;
  // 1 fresh .. 0 bailing (1 while seeking)
  readonly patienceFrac: number;
}

const cellDistance = (a: RoadCell, b: RoadCell): number =>
  Math.abs(a.gx - b.gx) + Math.abs(a.gz - b.gz);

// Trip length band, in grid cells, for each tier.
const tierRange = (t: FareTier): readonly [number, number] => {
  if (t === "short") {
    return [4, FARE.tierShortMax];
  }
  if (t === "medium") {
    return [FARE.tierShortMax + 1, FARE.tierMediumMax];
  }
  return [FARE.tierMediumMax + 1, FARE.tierLongMax];
};

const PASSENGER_HEIGHT = 1.5;

interface WaitingFare {
  readonly cell: RoadCell;
  readonly pos: THREE.Vector3;
  readonly passenger: THREE.Object3D;
  readonly tier: FareTier;
  readonly beacon: Beacon;
}

interface Carrying {
  readonly from: RoadCell;
  readonly dest: RoadCell;
  readonly pos: THREE.Vector3;
  readonly rideStart: number;
  readonly tiles: number;
  readonly tier: FareTier;
  readonly patienceBudget: number;
}

// A passenger running to the cab (pickup) or walking off (dropoff).
interface Extra {
  readonly node: THREE.Object3D;
  readonly kind: "board" | "leave";
  t: number;
  readonly from: THREE.Vector3;
  readonly dir: THREE.Vector3;
  // Bounds-normalised standing scale; the animations multiply it. Hardcoding
  // an animation scale instead popped the passenger to a different size than
  // the one that was standing there a frame earlier.
  readonly base: number;
}

export class FareManager {
  readonly group = new THREE.Group();
  private waiting: WaitingFare[] = [];
  private carrying: Carrying | null = null;
  private carryBeacon: Beacon;
  private extras: Extra[] = [];
  private clock = 0;
  // next waiting-fare top-up time
  private spawnAt = 0;
  private firstSpawn = true;
  private rng: Rng;
  // TRAILER (src/trailer/): autonomous spawning frozen; next pickup's
  // destination forced. Both stay inert in normal play (reset() clears them).
  private trailerHold = false;
  private trailerDest: RoadCell | null = null;

  private cache: ModelCache;
  private city: CityModel;

  constructor(cache: ModelCache, city: CityModel, seed = 7) {
    this.cache = cache;
    this.city = city;
    this.rng = new Rng(seed);
    this.carryBeacon = new Beacon(CARRY_COLOR);
    this.carryBeacon.setVisible(false);
    this.group.add(this.carryBeacon.group);
  }

  reset(carX: number, carZ: number): void {
    this.clock = 0;
    this.spawnAt = 0;
    this.firstSpawn = true;
    this.trailerHold = false;
    this.trailerDest = null;
    this.clearStreet();
    const near: RoadCell = { gx: this.city.gridX(carX), gz: this.city.gridZ(carZ) };
    while (this.waiting.length < FARE.waitingFares) {
      this.spawnWaiting(near);
    }
  }

  private clearStreet(): void {
    this.carrying = null;
    this.carryBeacon.setVisible(false);
    for (const w of this.waiting) {
      this.group.remove(w.passenger);
      this.group.remove(w.beacon.group);
      w.beacon.dispose();
    }
    for (const e of this.extras) {
      this.group.remove(e.node);
    }
    this.waiting = [];
    this.extras = [];
  }

  /** TRAILER: freeze autonomous spawn/retire and clear the street — the
   *  director stages customers explicitly with stageTrailerFare(). */
  setTrailerHold(on: boolean): void {
    this.trailerHold = on;
    if (!on) {
      return;
    }
    this.trailerDest = null;
    this.clearStreet();
  }

  /** TRAILER: one deterministic customer — waits at `from`, rides to `dest`.
   *  Pickup/dropoff run through the normal update() event path. */
  stageTrailerFare(from: RoadCell, dest: RoadCell, tier: FareTier): void {
    this.setTrailerHold(true);
    this.trailerDest = dest;
    this.spawnWaitingAt(from, tier);
  }

  objective(): Objective | null {
    const c = this.carrying;
    if (c) {
      return {
        kind: "carry",
        patienceFrac: this.patienceFrac(),
        pos: c.pos,
        tier: c.tier,
        tiles: c.tiles,
      };
    }
    let best: WaitingFare | null = null;
    let bd = Infinity;
    for (const w of this.waiting) {
      // caller-relative distance handled by HUD; any stable pick works
      const d = w.pos.lengthSq();
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    if (!best) {
      return null;
    }
    return { kind: "seek", patienceFrac: 1, pos: best.pos, tier: best.tier, tiles: 0 };
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
    return this.waiting.map((w) => ({ tier: w.tier, x: w.pos.x, z: w.pos.z }));
  }

  patienceFrac(): number {
    const c = this.carrying;
    if (!c) {
      return 1;
    }
    const elapsed = this.clock - c.rideStart;
    return Math.max(0, Math.min(1, 1 - elapsed / c.patienceBudget));
  }

  private hasLotNeighbor(c: RoadCell): boolean {
    for (const d of [N, E, S, W] as const) {
      const [dx, dz] = DIR_DELTA[d];
      if (this.city.plan.cells[c.gx + dx]?.[c.gz + dz] === "lot") {
        return true;
      }
    }
    return false;
  }

  private pickCell(from: RoadCell, min: number, max: number): RoadCell {
    const cells = this.city.roadCells;
    const inRange = cells.filter((c) => {
      const d = cellDistance(from, c);
      return d >= min && d <= max;
    });
    // Prefer cells with a building lot next to them so the fare stands at a real
    // curb, not stranded in the middle of a 4-way intersection.
    const curbside = inRange.filter((c) => this.hasLotNeighbor(c));
    if (curbside.length > 0) {
      return this.rng.pick(curbside);
    }
    if (inRange.length > 0) {
      return this.rng.pick(inRange);
    }
    return this.rng.pick(cells);
  }

  // A point on the sidewalk of a road cell: project onto the street EDGE and
  // stand just past the asphalt on the lot side — correct on axis streets,
  // diagonals and curves alike.
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
    const cx = this.city.worldX(cell.gx);
    const cz = this.city.worldZ(cell.gz);
    const hit = this.city.network.nearest(cx, cz, ROAD_TILE * 1.2);
    if (hit) {
      let nx = -hit.tz;
      let nz = hit.tx;
      if (nx * dx + nz * dz < 0) {
        nx = -nx;
        nz = -nz;
      }
      // on the sidewalk, facing the kerb
      const off = hit.edge.half + 0.65;
      const x = hit.x + nx * off;
      const z = hit.z + nz * off;
      return new THREE.Vector3(x, this.city.heightAt(x, z), z);
    }
    const x = cx + dx * ROAD_TILE * 0.425;
    const z = cz + dz * ROAD_TILE * 0.425;
    return new THREE.Vector3(x, this.city.heightAt(x, z), z);
  }

  private rollTier(): FareTier {
    const r = this.rng.range(0, 1);
    if (r < 0.45) {
      return "short";
    }
    if (r < 0.8) {
      return "medium";
    }
    return "long";
  }

  private spawnWaiting(near: RoadCell): void {
    // The very first customer of a run stands close — the first full loop
    // (pickup → dropoff → $$$ → +time) must land inside ~30 seconds. After
    // that, customers scatter across a wide ring so pickups pull the taxi
    // all over the city instead of orbiting one block.
    const min = this.firstSpawn ? 3 : FARE.seekMin;
    const max = this.firstSpawn ? FARE.firstSeekMax : FARE.seekMax;
    this.firstSpawn = false;
    const cell = this.pickCell(near, min, max);
    // Don't stack two customers on the same cell.
    if (this.waiting.some((w) => w.cell.gx === cell.gx && w.cell.gz === cell.gz)) {
      return;
    }
    this.spawnWaitingAt(cell, this.rollTier());
  }

  // Shared placement tail of spawnWaiting, with the cell and tier chosen by
  // the caller (trailer staging picks both deterministically).
  private spawnWaitingAt(cell: RoadCell, tier: FareTier): void {
    const pos = this.curbPoint(cell);
    // Bounds come from the model actually instanced — reading CHARACTERS[0]
    // instead made every other character render at the wrong height.
    const url = modelUrl("characters", this.rng.pick(CHARACTERS));
    const passenger = this.cache.instance(url);
    passenger.scale.setScalar(PASSENGER_HEIGHT / Math.max(this.cache.bounds(url).size.y, 0.001));
    passenger.position.copy(pos);
    passenger.rotation.y = this.rng.range(0, Math.PI * 2);
    this.group.add(passenger);
    const beacon = new Beacon(tierColor(tier), tier);
    beacon.setPos(pos.x, pos.y, pos.z);
    this.group.add(beacon.group);
    this.waiting.push({ beacon, cell, passenger, pos, tier });
  }

  update(dt: number, car: Car): FareEvent {
    this.clock += dt;
    this.carryBeacon.update(dt);
    // Waiting beacons only matter when you can actually board — hide them
    // while carrying so the sky isn't full of non-interactible beams.
    const seeking = this.carrying === null;
    for (const w of this.waiting) {
      w.beacon.setVisible(seeking);
      w.beacon.update(dt);
      // idle bob
      w.passenger.position.y = w.pos.y + Math.sin(this.clock * 4 + w.pos.x) * 0.08;
    }

    this.updateExtras(dt, car);

    // Customers the taxi left far behind relocate: retire the farthest (one
    // per tick — no visible mass despawn) and let the top-up respawn it in
    // the ring around wherever the taxi is NOW, so pickups never sit static
    // on the other side of the map. Frozen while the trailer director stages
    // customers by hand.
    const carCell: RoadCell = {
      gx: this.city.gridX(car.position.x),
      gz: this.city.gridZ(car.position.z),
    };
    if (!this.trailerHold) {
      this.relocateAndTopUp(carCell);
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
        return { kind: "dropoff", pos: c.pos.clone(), rideTime, tier: c.tier, tiles: c.tiles };
      }
      return { kind: "none" };
    }

    // Seeking: board the nearest waiting customer inside the pickup radius.
    for (let i = 0; i < this.waiting.length; i += 1) {
      const w = this.waiting[i];
      if (!w) {
        continue;
      }
      const dx = car.position.x - w.pos.x;
      const dz = car.position.z - w.pos.z;
      if (dx * dx + dz * dz > FARE.pickupRadius * FARE.pickupRadius) {
        continue;
      }
      this.waiting.splice(i, 1);
      this.group.remove(w.beacon.group);
      w.beacon.dispose();
      // The boarding run replaces the idle passenger.
      this.extras.push({
        // already carries the standing scale
        base: w.passenger.scale.x,
        dir: new THREE.Vector3(),
        from: w.pos.clone(),
        kind: "board",
        node: w.passenger,
        t: 0,
      });
      const [tMin, tMax] = tierRange(w.tier);
      const dest = this.trailerDest ?? this.pickCell(w.cell, tMin, tMax);
      const pos = this.curbPoint(dest);
      const tiles = cellDistance(w.cell, dest);
      this.carryBeacon.setColor(CARRY_COLOR);
      this.carryBeacon.setPos(pos.x, pos.y, pos.z);
      this.carryBeacon.setVisible(true);
      this.carrying = {
        dest,
        from: w.cell,
        patienceBudget: parSeconds(tiles) * FARE.patienceParMult,
        pos,
        rideStart: this.clock,
        tier: w.tier,
        tiles,
      };
      return { dest, kind: "pickup", pos: w.pos.clone(), tier: w.tier, tiles };
    }
    return { kind: "none" };
  }

  // Passenger theater: run-to-cab boarding + walk-away leaving.
  private updateExtras(dt: number, car: Car): void {
    for (let i = this.extras.length - 1; i >= 0; i -= 1) {
      const e = this.extras[i];
      if (!e) {
        continue;
      }
      e.t += dt;
      let f: number;
      if (e.kind === "board") {
        f = Math.min(1, e.t / 0.45);
        e.node.position.lerpVectors(e.from, car.position, f);
        e.node.scale.setScalar(e.base * (1 - f * 0.7));
      } else {
        f = Math.min(1, e.t / 1.6);
        e.node.position.copy(e.from).addScaledVector(e.dir, f * 4);
        const pop = e.t < 0.25 ? e.t / 0.25 : 1;
        e.node.scale.setScalar(e.base * pop);
      }
      if (f >= 1) {
        this.group.remove(e.node);
        this.extras.splice(i, 1);
      }
    }
  }

  // Retire the farthest stranded customer (one per tick) and top the street
  // back up around wherever the taxi is now.
  private relocateAndTopUp(carCell: RoadCell): void {
    if (!this.carrying) {
      let farthest = -1;
      let fd: number = FARE.seekRetire;
      for (let i = 0; i < this.waiting.length; i += 1) {
        const w = this.waiting[i];
        if (!w) {
          continue;
        }
        const d = cellDistance(w.cell, carCell);
        if (d > fd) {
          fd = d;
          farthest = i;
        }
      }
      if (farthest >= 0) {
        this.retireWaiting(farthest);
      }
    }

    if (this.waiting.length < FARE.waitingFares && this.clock >= this.spawnAt) {
      this.spawnAt = this.clock + 0.4;
      this.spawnWaiting(carCell);
    }
  }

  // Quietly remove a waiting customer (relocation — not a pickup or bail).
  private retireWaiting(i: number): void {
    const w = this.waiting[i];
    if (!w) {
      return;
    }
    this.waiting.splice(i, 1);
    this.group.remove(w.passenger);
    this.group.remove(w.beacon.group);
    w.beacon.dispose();
  }

  private spawnLeaver(at: THREE.Vector3): void {
    const url = modelUrl("characters", this.rng.pick(CHARACTERS));
    const node = this.cache.instance(url);
    const base = PASSENGER_HEIGHT / Math.max(this.cache.bounds(url).size.y, 0.001);
    // The pop-in starts at 0; setting it before the add keeps the first frame
    // from flashing the raw model at full size.
    node.scale.setScalar(0);
    node.position.copy(at);
    node.rotation.y = this.rng.range(0, Math.PI * 2);
    const ang = this.rng.range(0, Math.PI * 2);
    this.group.add(node);
    this.extras.push({
      base,
      dir: new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang)),
      from: at.clone(),
      kind: "leave",
      node,
      t: 0,
    });
  }
}
