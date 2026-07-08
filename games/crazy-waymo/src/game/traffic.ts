import type { RigidBody } from "@dimforge/rapier3d-compat";
import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl, POLICE_CAR, SERVICE_CARS, TRAFFIC_CARS } from "../assets/manifest";
import type { PhysicsWorld } from "../physics/physics-world";
import { ROAD_TILE, ROAD_Y, TRAFFIC } from "../shared/constants";
import { Rng } from "../shared/rng";
import type { CityModel, RoadCell } from "../world/city";
import type { NetEdge, RoadNetwork } from "../world/network";
import { type DistrictChar, districtAt } from "../world/sf-map";
import { slopeQuaternion } from "../world/terrain";

// Traffic drives the vector road NETWORK directly: each car is (edge,
// arclength, direction, lane offset). At a junction it hands off through a
// short quadratic bezier around the node — real cornering — onto the next
// edge, chosen with a keep-straight bias. There is no grid in this file.

const MODEL_YAW_OFFSET = 0; // Kenney cars face +Z
const SCRATCH_N = new THREE.Vector3();

const RECYCLE_DIST = ROAD_TILE * 20; // beyond this, teleport ahead of the player
const RESPAWN_MIN = ROAD_TILE * 6;
const RESPAWN_MAX = ROAD_TILE * 12;
const RESPAWN_GUARD = ROAD_TILE * 4; // last resort: never this close
const POLICE_SHARE = 0.08;
const SERVICE_SHARE = 0.14;
const POLICE_SPEED_MULT = 1.25;
const REACT_RADIUS = 8;
const REACT_DOT = 0.5;
const BRAKE_FACTOR = 0.35;
const BRAKE_DURATION = 1.0;
const HONK_COOLDOWN = 2.5;
const BODY_LIFT = 0.8;
const WRECK_RESPAWN_S = 7;
const KEEP_STRAIGHT = 0.62; // odds of taking the straightest arm at a junction
const BODY_OFFSET = new THREE.Vector3();

export type VehicleKind = "civilian" | "service" | "police";

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

// A car's position along the graph: either mid-edge, or crossing a junction
// on a bezier between two edge trim points.
type EdgePhase = {
  kind: "edge";
  edge: NetEdge;
  s: number; // arclength (edge frame, a→b)
  dir: 1 | -1; // +1 travels a→b
};
type NodePhase = {
  kind: "node";
  t: number; // 0..1 along the bezier
  len: number; // approximate bezier length
  p0x: number; p0z: number;
  p1x: number; p1z: number; // control = node position
  p2x: number; p2z: number;
  next: NetEdge;
  nextDir: 1 | -1;
};

export class TrafficCar {
  readonly object3D: THREE.Object3D;
  readonly kind: VehicleKind;
  readonly position = new THREE.Vector3();
  readonly radius = 1.35;
  hitCooldown = 0;
  missCooldown = 0;
  wantsHonk = false;
  body: RigidBody | null = null;
  wrecked = false;
  wreckTime = 0;
  puntCooldown = 0;
  tanX = 0; // unit travel tangent — yaw, lane offset, react, following
  tanZ = 1;
  followFactor = 1; // 0..1 speed clamp from the car ahead (set by Traffic)
  private phase: EdgePhase | NodePhase;
  private lane = 2.0;
  private readonly baseSpeed: number;
  private brakeTimer = 0;
  private honkCooldown = 0;
  private yaw = 0;
  private targetQuat = new THREE.Quaternion();

  constructor(
    object3D: THREE.Object3D,
    kind: VehicleKind,
    edge: NetEdge,
    s: number,
    dir: 1 | -1,
    speed: number,
    private network: RoadNetwork,
    private rng: Rng,
  ) {
    this.object3D = object3D;
    this.kind = kind;
    this.baseSpeed = speed;
    this.phase = { kind: "edge", edge, s, dir };
    this.lane = Math.min(edge.half * 0.42, 2.4);
  }

  respawn(edge: NetEdge, s: number, dir: 1 | -1): void {
    this.phase = { kind: "edge", edge, s, dir };
    this.lane = Math.min(edge.half * 0.42, 2.4);
    this.hitCooldown = 0;
    this.missCooldown = 0;
    this.brakeTimer = 0;
    this.honkCooldown = 0;
    this.wantsHonk = false;
    this.wrecked = false;
    this.wreckTime = 0;
    this.puntCooldown = 0;
  }

  // The taxi is about to hit this car: hand it to Rapier and let the taxi's
  // real momentum do the shoving (pure physics — no scripted push). Idempotent.
  punt(physics: PhysicsWorld): void {
    const body = this.body;
    if (!body || this.wrecked) return;
    physics.makeDynamic(body);
    this.wrecked = true;
    this.wreckTime = 0;
  }

  // Pick the outgoing edge at `node`, arriving along (tx, tz). Straightest
  // arm preferred; never the arriving edge unless it's a dead end.
  private pickNext(node: number, fromEdge: NetEdge, tx: number, tz: number): { edge: NetEdge; dir: 1 | -1 } {
    const candidates: { edge: NetEdge; dir: 1 | -1; dot: number }[] = [];
    for (const id of this.network.nodeEdges[node] ?? []) {
      const e = this.network.edges[id];
      if (!e || e === fromEdge) continue;
      const dir: 1 | -1 = e.a === node ? 1 : -1;
      const smp = this.network.sample(e, dir > 0 ? Math.min(4, e.len) : Math.max(e.len - 4, 0));
      const dot = (smp.tx * tx + smp.tz * tz) * dir;
      candidates.push({ edge: e, dir, dot });
    }
    if (candidates.length === 0) {
      // Dead end: turn around.
      return { edge: fromEdge, dir: fromEdge.a === node ? 1 : -1 };
    }
    candidates.sort((a, b) => b.dot - a.dot);
    const pick =
      candidates.length > 1 && !this.rng.chance(KEEP_STRAIGHT)
        ? candidates[1 + this.rng.int(candidates.length - 1)]
        : candidates[0];
    const chosen = pick ?? candidates[0];
    if (!chosen) return { edge: fromEdge, dir: fromEdge.a === node ? 1 : -1 };
    return { edge: chosen.edge, dir: chosen.dir };
  }

  // Leave the current edge across `node` onto the next one.
  private enterNode(node: number, edge: NetEdge, exitS: number): void {
    const nodePos = this.network.nodes[node];
    const out = this.pickNext(node, edge, this.tanX, this.tanZ);
    const nextTrim = Math.min(this.network.nodeTrim(out.dir > 0 ? out.edge.a : out.edge.b), out.edge.len * 0.45);
    const entryS = out.dir > 0 ? nextTrim : out.edge.len - nextTrim;
    const p0 = this.network.sample(edge, exitS);
    const p2 = this.network.sample(out.edge, entryS);
    const p1x = nodePos ? nodePos[0] : (p0.x + p2.x) / 2;
    const p1z = nodePos ? nodePos[1] : (p0.z + p2.z) / 2;
    const len =
      Math.hypot(p1x - p0.x, p1z - p0.z) + Math.hypot(p2.x - p1x, p2.z - p1z) || 0.5;
    this.phase = {
      kind: "node",
      t: 0,
      len,
      p0x: p0.x, p0z: p0.z,
      p1x, p1z,
      p2x: p2.x, p2z: p2.z,
      next: out.edge,
      nextDir: out.dir,
    };
    this.lane = Math.min(out.edge.half * 0.42, 2.4);
  }

  update(dt: number, city: CityModel, playerX: number, playerZ: number): void {
    if (this.hitCooldown > 0) this.hitCooldown -= dt;
    if (this.missCooldown > 0) this.missCooldown -= dt;
    if (this.honkCooldown > 0) this.honkCooldown -= dt;
    if (this.puntCooldown > 0) this.puntCooldown -= dt;

    // Wrecked: physics owns it until the recycler respawns it.
    if (this.wrecked) {
      this.wreckTime += dt;
      return;
    }

    // Player reaction: taxi close and roughly ahead → brake + honk once.
    if (dt > 0) {
      const dx = playerX - this.position.x;
      const dz = playerZ - this.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > 1e-6 && distSq < REACT_RADIUS * REACT_RADIUS) {
        if (this.tanX * dx + this.tanZ * dz > REACT_DOT * Math.sqrt(distSq)) {
          if (this.brakeTimer <= 0 && this.honkCooldown <= 0) {
            this.wantsHonk = true;
            this.honkCooldown = HONK_COOLDOWN;
          }
          this.brakeTimer = BRAKE_DURATION;
        }
      }
      if (this.brakeTimer > 0) this.brakeTimer -= dt;
    }

    const brakeMul = this.brakeTimer > 0 ? BRAKE_FACTOR : 1;
    const speed = this.baseSpeed * Math.min(brakeMul, this.followFactor);

    // --- Advance along the graph ---
    let px: number;
    let pz: number;
    if (this.phase.kind === "edge") {
      const ph = this.phase;
      ph.s += speed * dt * ph.dir;
      const trimA = Math.min(this.network.nodeTrim(ph.edge.a), ph.edge.len * 0.45);
      const trimB = Math.min(this.network.nodeTrim(ph.edge.b), ph.edge.len * 0.45);
      if (ph.dir > 0 && ph.s >= ph.edge.len - trimB) {
        this.enterNode(ph.edge.b, ph.edge, ph.edge.len - trimB);
      } else if (ph.dir < 0 && ph.s <= trimA) {
        this.enterNode(ph.edge.a, ph.edge, trimA);
      }
    }
    if (this.phase.kind === "node") {
      const ph = this.phase;
      ph.t += (speed * dt) / ph.len;
      if (ph.t >= 1) {
        const trim = Math.min(
          this.network.nodeTrim(ph.nextDir > 0 ? ph.next.a : ph.next.b),
          ph.next.len * 0.45,
        );
        const s = ph.nextDir > 0 ? trim : ph.next.len - trim;
        this.phase = { kind: "edge", edge: ph.next, s, dir: ph.nextDir };
      }
    }

    // --- Pose from the current phase ---
    if (this.phase.kind === "edge") {
      const ph = this.phase;
      const smp = this.network.sample(ph.edge, ph.s);
      this.tanX = smp.tx * ph.dir;
      this.tanZ = smp.tz * ph.dir;
      px = smp.x - this.tanZ * this.lane;
      pz = smp.z + this.tanX * this.lane;
    } else {
      const ph = this.phase;
      const t = Math.min(ph.t, 1);
      const u = 1 - t;
      const bx = u * u * ph.p0x + 2 * u * t * ph.p1x + t * t * ph.p2x;
      const bz = u * u * ph.p0z + 2 * u * t * ph.p1z + t * t * ph.p2z;
      let tx = u * (ph.p1x - ph.p0x) + t * (ph.p2x - ph.p1x);
      let tz = u * (ph.p1z - ph.p0z) + t * (ph.p2z - ph.p1z);
      const tl = Math.hypot(tx, tz);
      if (tl > 1e-4) {
        tx /= tl;
        tz /= tl;
        this.tanX = tx;
        this.tanZ = tz;
      }
      px = bx - this.tanZ * this.lane;
      pz = bz + this.tanX * this.lane;
    }

    // Axle-composite ground height (centre-only sampling buries the nose on
    // convex crests).
    const gy = Math.max(
      city.terrain.heightAt(px, pz),
      (city.terrain.heightAt(px + this.tanX * 1.2, pz + this.tanZ * 1.2) +
        city.terrain.heightAt(px - this.tanX * 1.2, pz - this.tanZ * 1.2)) /
        2,
    );
    this.position.set(px, gy + ROAD_Y, pz);
    this.object3D.position.copy(this.position);

    const targetYaw = Math.atan2(this.tanX, this.tanZ) + MODEL_YAW_OFFSET;
    let d = ((targetYaw - this.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, dt * 8);
    const n = city.terrain.normalInto(SCRATCH_N, px, pz);
    slopeQuaternion(this.targetQuat, this.yaw, n);
    if (dt === 0) this.object3D.quaternion.copy(this.targetQuat);
    else this.object3D.quaternion.slerp(this.targetQuat, Math.min(1, dt * 10));

    // Drag the kinematic body along the route (it shoves wrecks aside).
    if (this.body) {
      this.body.setNextKinematicTranslation({
        x: this.position.x,
        y: this.position.y + BODY_LIFT,
        z: this.position.z,
      });
      const q = this.object3D.quaternion;
      this.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
  }

  // After the physics step: wrecked meshes follow their rigid bodies.
  syncFromBody(): void {
    const body = this.body;
    if (!body || !this.wrecked) return;
    const t = body.translation();
    const r = body.rotation();
    this.object3D.quaternion.set(r.x, r.y, r.z, r.w);
    BODY_OFFSET.set(0, BODY_LIFT, 0).applyQuaternion(this.object3D.quaternion);
    this.object3D.position.set(t.x - BODY_OFFSET.x, t.y - BODY_OFFSET.y, t.z - BODY_OFFSET.z);
    this.position.copy(this.object3D.position);
  }
}

export type TrafficOpts = { seed?: number; avoid?: RoadCell; avoidR?: number };

export class Traffic {
  readonly group = new THREE.Group();
  readonly cars: TrafficCar[] = [];
  private rng: Rng;
  private city: CityModel;
  private network: RoadNetwork;
  // Edges repeated by district weight — random index = district-weighted pick.
  private readonly weightedEdges: NetEdge[] = [];

  constructor(
    cache: ModelCache,
    city: CityModel,
    opts: TrafficOpts = {},
    private physics: PhysicsWorld | null = null,
  ) {
    this.city = city;
    this.network = city.network;
    this.rng = new Rng(opts.seed ?? 99);

    for (const e of this.network.edges) {
      if (e.len < ROAD_TILE) continue;
      const mid = this.network.sample(e, e.len / 2);
      const w = districtSpawnWeight(
        districtAt(city.gridX(mid.x), city.gridZ(mid.z)).character,
      );
      for (let i = 0; i < w; i++) this.weightedEdges.push(e);
    }

    const avoid = opts.avoid;
    const avoidR = (opts.avoidR ?? 4) * ROAD_TILE;
    const ax = avoid ? city.worldX(avoid.gx) : 0;
    const az = avoid ? city.worldZ(avoid.gz) : 0;
    const count = TRAFFIC.count;
    for (let i = 0; i < count && this.weightedEdges.length > 0; i++) {
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
        if (avoid && Math.hypot(x - ax, z - az) < avoidR) return false;
        return this.clearOfCars(x, z, null);
      });
      if (!spot) break;
      const obj = cache.instance(modelUrl("cars", model));
      this.group.add(obj);
      const speed =
        this.rng.range(TRAFFIC.minSpeed, TRAFFIC.maxSpeed) *
        (kind === "police" ? POLICE_SPEED_MULT : 1);
      const car = new TrafficCar(obj, kind, spot.edge, spot.s, spot.dir, speed, this.network, this.rng);
      car.update(0, city, 0, 0);
      if (this.physics) {
        car.body = this.physics.createCarBody(
          car.position.x,
          car.position.y + BODY_LIFT,
          car.position.z,
        );
      }
      this.cars.push(car);
    }
  }

  // Random district-weighted edge spot passing `ok` (bounded retries).
  private pickSpot(
    ok: (x: number, z: number) => boolean,
  ): { edge: NetEdge; s: number; dir: 1 | -1; x: number; z: number } | null {
    for (let attempt = 0; attempt < 24; attempt++) {
      const edge = this.weightedEdges[this.rng.int(this.weightedEdges.length)];
      if (!edge) continue;
      const s = this.rng.range(edge.len * 0.2, edge.len * 0.8);
      const smp = this.network.sample(edge, s);
      if (!ok(smp.x, smp.z)) continue;
      return { edge, s, dir: this.rng.chance(0.5) ? 1 : -1, x: smp.x, z: smp.z };
    }
    return null;
  }

  private clearOfCars(x: number, z: number, self: TrafficCar | null): boolean {
    for (const c of this.cars) {
      if (c === self) continue;
      if (Math.hypot(c.position.x - x, c.position.z - z) < ROAD_TILE * 1.5) return false;
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
        if (avoid && Math.hypot(x - ax, z - az) < r) return false;
        return this.clearOfCars(x, z, c);
      });
      if (!spot) continue;
      c.respawn(spot.edge, spot.s, spot.dir);
      c.update(0, this.city, 0, 0);
      this.restoreBody(c);
    }
  }

  private restoreBody(c: TrafficCar): void {
    if (!c.body || !this.physics) return;
    this.physics.makeKinematic(c.body);
    this.physics.teleport(
      c.body,
      c.position.x,
      c.position.y + BODY_LIFT,
      c.position.z,
      c.object3D.quaternion,
    );
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

    // Car-following separation: hold behind a same-direction car (or a wreck)
    // ahead in the same lane. Coincident pairs brake exactly one by index.
    for (const c of this.cars) c.followFactor = 1;
    for (let i = 0; i < this.cars.length; i++) {
      const a = this.cars[i];
      if (!a || a.wrecked) continue;
      for (let j = 0; j < this.cars.length; j++) {
        const b = this.cars[j];
        if (!b || a === b) continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const ahead = dx * a.tanX + dz * a.tanZ;
        if (ahead > 7) continue;
        if (ahead < 0.5) {
          if (Math.hypot(dx, dz) < 2 && i > j) a.followFactor = 0;
          continue;
        }
        const lat = Math.abs(-dx * a.tanZ + dz * a.tanX);
        if (lat > 2.2) continue;
        if (!b.wrecked && b.tanX * a.tanX + b.tanZ * a.tanZ < 0.3) continue;
        a.followFactor = Math.min(a.followFactor, ahead < 3.5 ? 0 : 0.45);
      }
    }

    for (const c of this.cars) {
      const d = Math.hypot(c.position.x - playerX, c.position.z - playerZ);
      const recycleWreck = c.wrecked && c.wreckTime > WRECK_RESPAWN_S;
      if (d > RECYCLE_DIST || recycleWreck) {
        // Respawn in a ring ahead of the player (any ring cell as fallback).
        const spot =
          this.pickSpot((x, z) => {
            const dist = Math.hypot(x - playerX, z - playerZ);
            if (dist < RESPAWN_MIN || dist > RESPAWN_MAX) return false;
            if ((x - playerX) * hx + (z - playerZ) * hz < 0) return false;
            return this.clearOfCars(x, z, c);
          }) ??
          this.pickSpot((x, z) => {
            const dist = Math.hypot(x - playerX, z - playerZ);
            return dist > RESPAWN_GUARD && this.clearOfCars(x, z, c);
          });
        if (spot) {
          c.respawn(spot.edge, spot.s, spot.dir);
          c.update(0, city, 0, 0);
          this.restoreBody(c);
        }
      }
      c.update(dt, city, playerX, playerZ);
    }
  }

  syncWrecked(): void {
    for (const c of this.cars) c.syncFromBody();
  }
}
