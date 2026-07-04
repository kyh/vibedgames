// Renders the other players' taxis in the shared free-roam city. The world is
// generated from a fixed CITY_SEED, so every client already builds an identical
// map — remote cars just need their networked transforms placed on it. Cars are
// smoothed toward the ~15 Hz updates and distance-culled so a full 64-player
// room stays cheap (only nearby taxis are instanced/updated).

import * as THREE from "three";

import type { PlayerMap } from "@vibedgames/multiplayer";

import type { ModelCache } from "../assets/loader";
import { modelUrl, PLAYER_CAR } from "../assets/manifest";
import type { Surface } from "../vehicle/car";
import { slopeQuaternion } from "../world/terrain";

/** Cull taxis farther than this (world units) from the local car. */
const RENDER_RADIUS = 320;
const RENDER_RADIUS_SQ = RENDER_RADIUS * RENDER_RADIUS;
/** Position/heading smoothing toward the networked target (per second). */
const LERP_RATE = 12;

export type RemoteTransform = { x: number; y: number; z: number; h: number };

/** A finite number, or null. `typeof NaN === "number"`, so guard finiteness. */
function finiteNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function readTransform(state: unknown): RemoteTransform | null {
  if (!state || typeof state !== "object") return null;
  const s = state as Record<string, unknown>;
  // Reject non-finite values so a bad/hostile peer can't feed NaN/Infinity into
  // slopeQuaternion and the Three.js transforms (which would freeze rendering).
  const x = finiteNum(s["x"]);
  const z = finiteNum(s["z"]);
  const h = finiteNum(s["h"]);
  if (x === null || z === null || h === null) return null;
  return { x, y: finiteNum(s["y"]) ?? 0, z, h };
}

type RemoteCar = {
  group: THREE.Group;
  beaconGeo: THREE.BufferGeometry;
  beaconMat: THREE.Material;
  cur: THREE.Vector3;
  curHeading: number;
  target: THREE.Vector3;
  targetHeading: number;
  seededPose: boolean;
};

export class RemoteCars {
  readonly group = new THREE.Group();
  private cars = new Map<string, RemoteCar>();
  private scratchN = new THREE.Vector3();
  private quat = new THREE.Quaternion();

  constructor(
    private readonly cache: ModelCache,
    private readonly surface: Surface,
  ) {}

  /** Adopt the latest player snapshot; `origin` is the local car for culling. */
  sync(players: PlayerMap, myId: string | null, origin: THREE.Vector3): void {
    const seen = new Set<string>();
    for (const [id, player] of Object.entries(players)) {
      if (id === myId) continue;
      const t = readTransform(player.state);
      if (!t) continue;
      seen.add(id);
      const dx = t.x - origin.x;
      const dz = t.z - origin.z;
      const near = dx * dx + dz * dz <= RENDER_RADIUS_SQ;
      let car = this.cars.get(id);
      if (!near) {
        // Out of range: drop the instance to keep 64-player rooms cheap. It
        // re-instances (snapped to the fresh pose) when it comes back near.
        if (car) this.remove(id, car);
        continue;
      }
      if (!car) car = this.spawn(id, t);
      car.target.set(t.x, t.y, t.z);
      car.targetHeading = t.h;
    }
    for (const [id, car] of this.cars) {
      if (!seen.has(id)) this.remove(id, car);
    }
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-LERP_RATE * dt);
    for (const car of this.cars.values()) {
      if (car.seededPose) {
        car.cur.copy(car.target);
        car.curHeading = car.targetHeading;
        car.seededPose = false;
      } else {
        car.cur.lerp(car.target, k);
        car.curHeading += shortestAngle(car.curHeading, car.targetHeading) * k;
      }
      const n = this.surface.normalInto(this.scratchN, car.cur.x, car.cur.z);
      slopeQuaternion(this.quat, car.curHeading, n);
      car.group.quaternion.copy(this.quat);
      car.group.position.copy(car.cur);
    }
  }

  count(): number {
    return this.cars.size;
  }

  dispose(): void {
    for (const [id, car] of this.cars) this.remove(id, car);
  }

  private spawn(id: string, t: RemoteTransform): RemoteCar {
    const group = new THREE.Group();
    group.scale.setScalar(1.12);
    group.add(this.cache.instance(modelUrl("cars", PLAYER_CAR)));

    // A colored roof beacon so players are told apart in a crowd.
    const beaconGeo = new THREE.SphereGeometry(0.32, 12, 8);
    const beaconMat = new THREE.MeshBasicMaterial({ color: colorForId(id) });
    const beacon = new THREE.Mesh(beaconGeo, beaconMat);
    beacon.position.set(0, 2.1, 0);
    group.add(beacon);

    this.group.add(group);
    const car: RemoteCar = {
      group,
      beaconGeo,
      beaconMat,
      cur: new THREE.Vector3(t.x, t.y, t.z),
      curHeading: t.h,
      target: new THREE.Vector3(t.x, t.y, t.z),
      targetHeading: t.h,
      seededPose: true,
    };
    this.cars.set(id, car);
    return car;
  }

  private remove(id: string, car: RemoteCar): void {
    this.group.remove(car.group);
    // Only the beacon is uniquely owned here; the car body is a shared-template
    // clone, so its geometry/material must NOT be disposed.
    car.beaconGeo.dispose();
    car.beaconMat.dispose();
    this.cars.delete(id);
  }
}

/** Shortest signed angle from `from` to `to`, in (-π, π]. */
function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Stable bright color from a player id (golden-angle hue hash). */
function colorForId(id: string): THREE.Color {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = ((h >>> 0) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.7, 0.55);
}
