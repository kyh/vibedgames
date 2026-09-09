import type { RigidBody } from "@dimforge/rapier3d-compat";
import * as THREE from "three";

import { ROAD_Y } from "../shared/constants";
import type { Rng } from "../shared/rng";
import type { CityModel } from "../world/city";
import { junctionControl, signalGreen } from "../world/junction-control";
import type { JunctionControl } from "../world/junction-control";
import type { NetEdge, RoadNetwork } from "../world/network";
import type { PhysicsWorld } from "../physics/physics-world";
import { slopeQuaternion } from "../world/terrain";

// One car on the vector road network: (edge, arclength, direction, lane
// offset), handed off through a short quadratic bezier at each junction.

// An outgoing junction choice: the edge to drive and which way along it.
interface NextLeg {
  edge: NetEdge;
  dir: 1 | -1;
}

// Kenney cars face +Z
const MODEL_YAW_OFFSET = 0;
const SCRATCH_N = new THREE.Vector3();
const CAR_M4 = new THREE.Matrix4();
const PART_M4 = new THREE.Matrix4();

const REACT_RADIUS = 8;
const REACT_DOT = 0.5;
const BRAKE_FACTOR = 0.35;
const BRAKE_DURATION = 1;
const HONK_COOLDOWN = 2.5;
export const BODY_LIFT = 0.8;

// odds of taking the straightest arm at a junction
const KEEP_STRAIGHT = 0.62;
// Junction control: cars start braking this far before the hold point, stop
// signs hold this long before rolling on. Player-adjacent arcade values —
// queues form and clear fast.
const CONTROL_LOOK = 12;
// hold point sits this far before the node trim
const HOLD_GAP = 1.5;
const STOP_HOLD_S = 0.7;
// junctionControl is pure but rebuilds arm geometry per call — memoize per
// network (traffic asks every frame per approaching car).
const controlCache = new WeakMap<RoadNetwork, Map<number, JunctionControl>>();
const controlAt = (network: RoadNetwork, node: number): JunctionControl => {
  let m = controlCache.get(network);
  if (!m) {
    m = new Map();
    controlCache.set(network, m);
  }
  let c = m.get(node);
  if (c === undefined) {
    c = junctionControl(network, node);
    m.set(node, c);
  }
  return c;
};
const BODY_OFFSET = new THREE.Vector3();
// Beyond this the car's kinematic body can't touch anything near the taxi
// (punts/wrecks/cones all live within ~40u of it) — stop feeding Rapier
// kinematic targets and teleport the body back under the car on re-entry.
const BODY_FAR = 80;
const BODY_FAR_SQ = BODY_FAR * BODY_FAR;

export type VehicleKind = "civilian" | "service" | "police";

// One batched-fleet instance slot: a mesh part of a car model inside the
// shared BatchedMesh, plus the part's local transform within the model.
export interface FleetPart {
  batch: THREE.BatchedMesh;
  instanceId: number;
  local: THREE.Matrix4;
}

// A car's position along the graph: either mid-edge, or crossing a junction
// on a bezier between two edge trim points.
interface EdgePhase {
  kind: "edge";
  edge: NetEdge;
  // arclength (edge frame, a→b)
  s: number;
  // +1 travels a→b
  dir: 1 | -1;
}
interface NodePhase {
  kind: "node";
  // junction being crossed (node-claim release)
  node: number;
  // 0..1 along the bezier
  t: number;
  // approximate bezier length
  len: number;
  p0x: number;
  p0z: number;
  p1x: number;
  // control = node position
  p1z: number;
  p2x: number;
  p2z: number;
  next: NetEdge;
  nextDir: 1 | -1;
}

export class TrafficCar {
  readonly object3D: THREE.Object3D;
  readonly kind: VehicleKind;
  readonly position = new THREE.Vector3();
  readonly radius = 1.35;
  hitCooldown = 0;
  missCooldown = 0;
  wantsHonk = false;
  body: RigidBody | null = null;
  // True while the kinematic body is far from the taxi and left un-fed
  // (cleared by the re-entry teleport in update, or by Traffic.restoreBody).
  bodyParked = false;
  wrecked = false;
  wreckTime = 0;
  puntCooldown = 0;
  // unit travel tangent — yaw, lane offset, react, following
  tanX = 0;
  tanZ = 1;
  // 0..1 speed clamp from the car ahead (set by Traffic)
  followFactor = 1;
  // Batched-fleet instance slots — the visual car (object3D is a bare anchor).
  private parts: readonly FleetPart[] = [];
  private phase: EdgePhase | NodePhase;
  private lane = 2;
  private readonly baseSpeed: number;
  private brakeTimer = 0;
  private honkCooldown = 0;
  private yaw = 0;
  private targetQuat = new THREE.Quaternion();
  // Junction-control state: the node whose box we already own (don't re-hold
  // or re-claim while creeping through), and how long we've been held at one.
  private clearedNode = -1;
  private stopHeld = 0;
  private network: RoadNetwork;
  private rng: Rng;
  private nodeClaims: Map<number, { car: TrafficCar; t: number }>;

  constructor(
    object3D: THREE.Object3D,
    kind: VehicleKind,
    edge: NetEdge,
    s: number,
    dir: 1 | -1,
    speed: number,
    network: RoadNetwork,
    rng: Rng,
    nodeClaims: Map<number, { car: TrafficCar; t: number }>,
  ) {
    this.network = network;
    this.rng = rng;
    this.nodeClaims = nodeClaims;
    this.object3D = object3D;
    this.kind = kind;
    this.baseSpeed = speed;
    this.phase = { dir, edge, kind: "edge", s };
    this.lane = Math.min(edge.half * 0.42, 2.4);
  }

  // Adopt this car's slots in the shared fleet batches and stamp the current
  // pose into them (called once by Traffic after the batches are built).
  attachParts(parts: readonly FleetPart[]): void {
    this.parts = parts;
    this.writeMatrices();
  }

  // Push object3D's pose into the fleet batches (carMatrix × partLocal).
  private writeMatrices(): void {
    CAR_M4.makeRotationFromQuaternion(this.object3D.quaternion).setPosition(this.object3D.position);
    for (const p of this.parts) {
      PART_M4.multiplyMatrices(CAR_M4, p.local);
      p.batch.setMatrixAt(p.instanceId, PART_M4);
    }
  }

  respawn(edge: NetEdge, s: number, dir: 1 | -1): void {
    this.phase = { dir, edge, kind: "edge", s };
    this.lane = Math.min(edge.half * 0.42, 2.4);
    this.hitCooldown = 0;
    this.missCooldown = 0;
    this.brakeTimer = 0;
    this.honkCooldown = 0;
    this.wantsHonk = false;
    this.wrecked = false;
    this.wreckTime = 0;
    this.puntCooldown = 0;
    this.clearedNode = -1;
    this.stopHeld = 0;
    for (const [n, tok] of this.nodeClaims) {
      if (tok.car === this) {
        this.nodeClaims.delete(n);
      }
    }
  }

  // The taxi is about to hit this car: hand it to Rapier and let the taxi's
  // real momentum do the shoving (pure physics — no scripted push). Idempotent.
  punt(physics: PhysicsWorld): void {
    const { body } = this;
    if (!body || this.wrecked) {
      return;
    }
    physics.makeDynamic(body);
    this.wrecked = true;
    this.wreckTime = 0;
  }

  // Pick the outgoing edge at `node`, arriving along (tx, tz). Straightest
  // arm preferred; never the arriving edge unless it's a dead end.
  private pickNext(node: number, fromEdge: NetEdge, tx: number, tz: number): NextLeg {
    const candidates: { edge: NetEdge; dir: 1 | -1; dot: number }[] = [];
    for (const id of this.network.nodeEdges[node] ?? []) {
      const e = this.network.edges[id];
      if (!e || e === fromEdge) {
        continue;
      }
      const dir: 1 | -1 = e.a === node ? 1 : -1;
      const smp = this.network.sample(e, dir > 0 ? Math.min(4, e.len) : Math.max(e.len - 4, 0));
      const dot = (smp.tx * tx + smp.tz * tz) * dir;
      candidates.push({ dir, dot, edge: e });
    }
    if (candidates.length === 0) {
      // Dead end: turn around.
      return { dir: fromEdge.a === node ? 1 : -1, edge: fromEdge };
    }
    candidates.sort((a, b) => b.dot - a.dot);
    const pick =
      candidates.length > 1 && !this.rng.chance(KEEP_STRAIGHT)
        ? candidates[1 + this.rng.int(candidates.length - 1)]
        : candidates[0];
    const chosen = pick ?? candidates[0];
    if (!chosen) {
      return { dir: fromEdge.a === node ? 1 : -1, edge: fromEdge };
    }
    return { dir: chosen.dir, edge: chosen.edge };
  }

  // Take the junction box at `node` if nobody is crossing it. First come,
  // first served — a stale claim (holder wrecked, recycled or stuck behind
  // something) expires so a queue can never deadlock.
  private claimNode(node: number, t: number): boolean {
    const tok = this.nodeClaims.get(node);
    if (tok && tok.car !== this && !tok.car.wrecked && t - tok.t <= 5) {
      return false;
    }
    this.nodeClaims.set(node, { car: this, t });
    return true;
  }

  // Leave the current edge across `node` onto the next one.
  private enterNode(node: number, edge: NetEdge, exitS: number): void {
    const nodePos = this.network.nodes[node];
    const out = this.pickNext(node, edge, this.tanX, this.tanZ);
    const nextTrim = Math.min(
      this.network.nodeTrim(out.dir > 0 ? out.edge.a : out.edge.b),
      out.edge.len * 0.45,
    );
    const entryS = out.dir > 0 ? nextTrim : out.edge.len - nextTrim;
    const p0 = this.network.sample(edge, exitS);
    const p2 = this.network.sample(out.edge, entryS);
    const p1x = nodePos ? nodePos[0] : (p0.x + p2.x) / 2;
    const p1z = nodePos ? nodePos[1] : (p0.z + p2.z) / 2;
    const len = Math.hypot(p1x - p0.x, p1z - p0.z) + Math.hypot(p2.x - p1x, p2.z - p1z) || 0.5;
    this.phase = {
      kind: "node",
      len,
      next: out.edge,
      nextDir: out.dir,
      node,
      p0x: p0.x,
      p0z: p0.z,
      p1x,
      p1z,
      p2x: p2.x,
      p2z: p2.z,
      t: 0,
    };
    this.lane = Math.min(out.edge.half * 0.42, 2.4);
  }

  update(
    dt: number,
    city: CityModel,
    playerX: number,
    playerZ: number,
    physics: PhysicsWorld | null = null,
    simTime = 0,
  ): void {
    this.tickCooldowns(dt);

    // Wrecked: physics owns it until the recycler respawns it.
    if (this.wrecked) {
      this.wreckTime += dt;
      return;
    }

    this.reactToPlayer(dt, playerX, playerZ);

    const brakeMul = this.brakeTimer > 0 ? BRAKE_FACTOR : 1;
    const controlFactor = this.junctionControlFactor(dt, simTime);
    const speed = this.baseSpeed * Math.min(brakeMul, this.followFactor, controlFactor);

    this.advanceAlongGraph(speed, dt);

    let px: number;
    let pz: number;
    const ph = this.phase;
    if (ph.kind === "edge") {
      const smp = this.network.sample(ph.edge, ph.s);
      this.tanX = smp.tx * ph.dir;
      this.tanZ = smp.tz * ph.dir;
      px = smp.x - this.tanZ * this.lane;
      pz = smp.z + this.tanX * this.lane;
    } else {
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
      city.heightAt(px, pz),
      (city.heightAt(px + this.tanX * 1.2, pz + this.tanZ * 1.2) +
        city.heightAt(px - this.tanX * 1.2, pz - this.tanZ * 1.2)) /
        2,
    );
    this.position.set(px, gy + ROAD_Y, pz);
    this.object3D.position.copy(this.position);

    const targetYaw = Math.atan2(this.tanX, this.tanZ) + MODEL_YAW_OFFSET;
    let d = ((targetYaw - this.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) {
      d += Math.PI * 2;
    }
    this.yaw += d * Math.min(1, dt * 8);
    const n = city.normalInto(SCRATCH_N, px, pz);
    slopeQuaternion(this.targetQuat, this.yaw, n);
    if (dt === 0) {
      this.object3D.quaternion.copy(this.targetQuat);
    } else {
      this.object3D.quaternion.slerp(this.targetQuat, Math.min(1, dt * 10));
    }

    this.dragKinematicBody(playerX, playerZ, physics);
    this.writeMatrices();
  }

  private tickCooldowns(dt: number): void {
    if (this.hitCooldown > 0) {
      this.hitCooldown -= dt;
    }
    if (this.missCooldown > 0) {
      this.missCooldown -= dt;
    }
    if (this.honkCooldown > 0) {
      this.honkCooldown -= dt;
    }
    if (this.puntCooldown > 0) {
      this.puntCooldown -= dt;
    }
  }

  // Player reaction: taxi close and roughly ahead → brake + honk once.
  private reactToPlayer(dt: number, playerX: number, playerZ: number): void {
    // Player reaction: taxi close and roughly ahead → brake + honk once.
    if (dt > 0) {
      const dx = playerX - this.position.x;
      const dz = playerZ - this.position.z;
      const distSq = dx * dx + dz * dz;
      if (
        distSq > 1e-6 &&
        distSq < REACT_RADIUS * REACT_RADIUS &&
        this.tanX * dx + this.tanZ * dz > REACT_DOT * Math.sqrt(distSq)
      ) {
        if (this.brakeTimer <= 0 && this.honkCooldown <= 0) {
          this.wantsHonk = true;
          this.honkCooldown = HONK_COOLDOWN;
        }
        this.brakeTimer = BRAKE_DURATION;
      }
      if (this.brakeTimer > 0) {
        this.brakeTimer -= dt;
      }
    }
  }

  // Junction control: brake to the hold point at a red signal, serve a full
  // stop (once) at stop signs, and claim the box before crossing one nothing
  // else arbitrates. Only while approaching on an edge — a car already
  // crossing the box always clears it.
  private junctionControlFactor(dt: number, simTime: number): number {
    let controlFactor = 1;
    if (this.phase.kind === "edge") {
      const ph = this.phase;
      const trimA = Math.min(this.network.nodeTrim(ph.edge.a), ph.edge.len * 0.45);
      const trimB = Math.min(this.network.nodeTrim(ph.edge.b), ph.edge.len * 0.45);
      const node = ph.dir > 0 ? ph.edge.b : ph.edge.a;
      const holdS = ph.dir > 0 ? ph.edge.len - trimB - HOLD_GAP : trimA + HOLD_GAP;
      const dist = ph.dir > 0 ? holdS - ph.s : ph.s - holdS;
      if (dist < CONTROL_LOOK && dist > -1) {
        const control = controlAt(this.network, node);
        if (control === "signal" && !signalGreen(node, this.tanX, this.tanZ, simTime)) {
          controlFactor = Math.min(1, Math.max(0, dist / 6));
        } else if (control === "stop" && this.clearedNode !== node) {
          controlFactor = Math.min(1, Math.max(0, dist / 6));
          if (dist <= 0.5) {
            this.stopHeld += dt;
            // Full stop served — now take the junction if it's free.
            if (this.stopHeld >= STOP_HOLD_S && this.claimNode(node, simTime)) {
              this.clearedNode = node;
              this.stopHeld = 0;
            }
          }
        } else if (this.clearedNode !== node) {
          // Uncontrolled nodes — and the conflicting arms a signal phase can
          // let through together — have no other conflict test, so two cars
          // would cross the box on intersecting beziers and interpenetrate in
          // plain view. Same claim as the all-way stop, without the hold: the
          // second car creeps to the hold point until the box is released.
          if (this.claimNode(node, simTime)) {
            this.clearedNode = node;
          } else {
            controlFactor = Math.min(1, Math.max(0, dist / 4));
          }
        }
      }
    }
    return controlFactor;
  }

  private advanceAlongGraph(speed: number, dt: number): void {
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
        if (this.nodeClaims.get(ph.node)?.car === this) {
          this.nodeClaims.delete(ph.node);
        }
        const trim = Math.min(
          this.network.nodeTrim(ph.nextDir > 0 ? ph.next.a : ph.next.b),
          ph.next.len * 0.45,
        );
        const s = ph.nextDir > 0 ? trim : ph.next.len - trim;
        this.phase = { dir: ph.nextDir, edge: ph.next, kind: "edge", s };
      }
    }
  }

  // Drag the kinematic body along the route (it shoves wrecks aside) — but
  // only near the taxi. Far cars park the body where it was (nothing out
  // there can touch it) and teleport it back under themselves on re-entry:
  // a swept kinematic move across the map would batter whatever it crossed.
  private dragKinematicBody(playerX: number, playerZ: number, physics: PhysicsWorld | null): void {
    if (this.body) {
      const bdx = this.position.x - playerX;
      const bdz = this.position.z - playerZ;
      if (bdx * bdx + bdz * bdz > BODY_FAR_SQ) {
        this.bodyParked = true;
      } else {
        if (this.bodyParked && physics) {
          this.bodyParked = false;
          physics.teleport(
            this.body,
            this.position.x,
            this.position.y + BODY_LIFT,
            this.position.z,
            this.object3D.quaternion,
          );
        }
        if (!this.bodyParked) {
          this.body.setNextKinematicTranslation({
            x: this.position.x,
            y: this.position.y + BODY_LIFT,
            z: this.position.z,
          });
          const q = this.object3D.quaternion;
          this.body.setNextKinematicRotation({ w: q.w, x: q.x, y: q.y, z: q.z });
        }
      }
    }
  }

  // After the physics step: wrecked meshes follow their rigid bodies.
  syncFromBody(): void {
    const { body } = this;
    if (!body || !this.wrecked) {
      return;
    }
    const t = body.translation();
    const r = body.rotation();
    this.object3D.quaternion.set(r.x, r.y, r.z, r.w);
    BODY_OFFSET.set(0, BODY_LIFT, 0).applyQuaternion(this.object3D.quaternion);
    this.object3D.position.set(t.x - BODY_OFFSET.x, t.y - BODY_OFFSET.y, t.z - BODY_OFFSET.z);
    this.position.copy(this.object3D.position);
    this.writeMatrices();
  }
}
