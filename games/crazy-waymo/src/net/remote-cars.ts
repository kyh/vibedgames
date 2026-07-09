// Renders the other players' taxis in the shared free-roam city. The world is
// generated from a fixed CITY_SEED, so every client already builds an identical
// map — remote cars just need their networked transforms placed on it. Cars are
// smoothed toward the ~15 Hz updates and distance-culled so a full 64-player
// room stays cheap (only nearby taxis are instanced/updated).

import * as THREE from "three";

import type { PlayerMap } from "@vibedgames/multiplayer";

import type { ModelCache } from "../assets/loader";

import type { Surface } from "../vehicle/car";
import { buildSkinBody, skinById } from "../vehicle/car";
import { slopeQuaternion } from "../world/terrain";

/** Instance taxis inside this radius (matches the city's DETAIL_DISTANCE so
 *  cars don't pop against still-visible props)… */
const RENDER_RADIUS = 520;
const RENDER_RADIUS_SQ = RENDER_RADIUS * RENDER_RADIUS;
/** …and only drop them beyond this — the hysteresis band stops a taxi pacing
 *  the boundary from re-cloning its GLB every few frames. */
const DROP_RADIUS_SQ = 580 * 580;
/** Position/heading smoothing toward the networked target (per second). */
const LERP_RATE = 12;
/** A target jumping farther than this is a respawn/reset — snap, don't streak. */
const SNAP_DIST_SQ = 40 * 40;
/** Remove taxis whose transform hasn't changed in this long (hidden tabs keep
 *  their socket open with rAF paused — they'd freeze mid-street forever). */
const IDLE_CULL_MS = 10_000;

export type RemoteTransform = {
  x: number;
  y: number;
  z: number;
  h: number;
  skin: string;
  msg: string;
  msgAt: number;
};

/** A finite number, or null. `typeof NaN === "number"`, so guard finiteness. */
function finiteNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function readTransform(state: unknown): RemoteTransform | null {
  if (!state || typeof state !== "object") return null;
  // Reject non-finite values so a bad/hostile peer can't feed NaN/Infinity into
  // slopeQuaternion and the Three.js transforms (which would freeze rendering).
  const x = finiteNum("x" in state ? state.x : null);
  const z = finiteNum("z" in state ? state.z : null);
  const h = finiteNum("h" in state ? state.h : null);
  if (x === null || z === null || h === null) return null;
  const o = state as Record<string, unknown>;
  return {
    x,
    y: finiteNum("y" in state ? state.y : null) ?? 0,
    z,
    h,
    skin: typeof o.skin === "string" ? o.skin : "waymo",
    msg: typeof o.msg === "string" ? o.msg.slice(0, 90) : "",
    msgAt: finiteNum(o.msgAt) ?? 0,
  };
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
  skin: string;
  lastMsgAt: number;
};

/** With an unchanged snapshot, still re-run the sweep this often: distance
 *  culling tracks the moving LOCAL car and idle taxis must age out even when
 *  no net message arrives. Well inside the 60u cull hysteresis band. */
const SWEEP_MS = 500;

type MovedStamp = { x: number; y: number; z: number; h: number; at: number };

export class RemoteCars {
  readonly group = new THREE.Group();
  private cars = new Map<string, RemoteCar>();
  private lastMoved = new Map<string, MovedStamp>();
  private lastPlayers: PlayerMap | null = null;
  private lastSweepAt = 0;
  private scratchN = new THREE.Vector3();
  private quat = new THREE.Quaternion();

  constructor(
    private readonly cache: ModelCache,
    private readonly surface: Surface,
    /** Called when a remote player sends a chat line (bubble goes here). */
    private readonly onChat?: (anchor: THREE.Object3D, text: string) => void,
  ) {}

  /** Adopt the latest player snapshot; `origin` is the local car for culling. */
  sync(players: PlayerMap, myId: string | null, origin: THREE.Vector3): void {
    const now = performance.now();
    // The client replaces the player map object on every net message — the
    // same reference means nothing changed, so skip the per-player walk
    // (this runs every frame; messages arrive at ~15 Hz).
    if (players === this.lastPlayers && now - this.lastSweepAt < SWEEP_MS) return;
    this.lastPlayers = players;
    this.lastSweepAt = now;
    const seen = new Set<string>();
    for (const [id, player] of Object.entries(players)) {
      if (id === myId) continue;
      const t = readTransform(player.state);
      if (!t) continue;
      seen.add(id);

      let moved = this.lastMoved.get(id);
      if (!moved) {
        moved = { x: t.x, y: t.y, z: t.z, h: t.h, at: now };
        this.lastMoved.set(id, moved);
      } else if (moved.x !== t.x || moved.y !== t.y || moved.z !== t.z || moved.h !== t.h) {
        moved.x = t.x;
        moved.y = t.y;
        moved.z = t.z;
        moved.h = t.h;
        moved.at = now;
      }
      const idle = now - moved.at > IDLE_CULL_MS;

      const dx = t.x - origin.x;
      const dz = t.z - origin.z;
      const distSq = dx * dx + dz * dz;
      let car = this.cars.get(id);
      // Hysteresis: instance when near, drop only when clearly far (or idle),
      // so a taxi pacing the boundary doesn't re-clone its GLB every frame.
      const keep = !idle && distSq <= (car ? DROP_RADIUS_SQ : RENDER_RADIUS_SQ);
      if (!keep) {
        // Out of range: drop the instance to keep 64-player rooms cheap. It
        // re-instances (snapped to the fresh pose) when it comes back near.
        if (car) this.remove(id, car);
        continue;
      }
      if (car && car.skin !== t.skin) {
        // player swapped robotaxi — rebuild the body with the new skin
        this.remove(id, car);
        car = undefined;
      }
      if (!car) car = this.spawn(id, t);
      if (t.msg && t.msgAt > car.lastMsgAt) {
        car.lastMsgAt = t.msgAt;
        this.onChat?.(car.group, t.msg);
      }
      car.target.set(t.x, t.y, t.z);
      car.targetHeading = t.h;
      // A big jump is a respawn/reset, not motion — snap instead of streaking
      // the taxi across the map through buildings.
      if (car.cur.distanceToSquared(car.target) > SNAP_DIST_SQ) car.seededPose = true;
    }
    for (const [id, car] of this.cars) {
      if (!seen.has(id)) this.remove(id, car);
    }
    for (const id of this.lastMoved.keys()) {
      if (!seen.has(id)) this.lastMoved.delete(id);
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
    // The sender's chosen robotaxi (Waymo/Zoox/Cybercab/Cruise), sensors and all.
    group.add(buildSkinBody(this.cache, skinById(t.skin)));

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
      skin: t.skin,
      lastMsgAt: t.msgAt, // don't replay a bubble that predates our arrival
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
