// Renders the other players' taxis in the shared free-roam city. The world is
// generated from a fixed CITY_SEED, so every client already builds an identical
// map — remote cars just need their networked transforms placed on it. Cars are
// smoothed toward the ~15 Hz updates and distance-culled so a full 64-player
// room stays cheap (only nearby taxis are instanced/updated).

import * as THREE from "three";

import type { PlayerMap } from "@vibedgames/multiplayer";

import type { ModelCache } from "../assets/loader";

import { isFiniteJsonNumber, isJsonObject, isJsonString } from "../shared/json";
import type { JsonValue } from "../shared/json";
import type { Surface } from "../vehicle/car";
import { buildSkinBody, skinById, skinModelUrl } from "../vehicle/car";
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

export interface RemoteTransform {
  x: number;
  y: number;
  z: number;
  h: number;
  skin: string;
  msg: string;
  msgAt: number;
}

/** A finite number, or null — a bad/hostile peer must not feed NaN/Infinity
 *  into slopeQuaternion and the Three.js transforms (which would freeze
 *  rendering). */
const finiteNum = (v: JsonValue | undefined): number | null => (isFiniteJsonNumber(v) ? v : null);

export const readTransform = (state: JsonValue | undefined): RemoteTransform | null => {
  if (!isJsonObject(state)) {
    return null;
  }
  const x = finiteNum(state.x);
  const z = finiteNum(state.z);
  const h = finiteNum(state.h);
  if (x === null || z === null || h === null) {
    return null;
  }
  return {
    h,
    msg: isJsonString(state.msg) ? state.msg.slice(0, 90) : "",
    msgAt: finiteNum(state.msgAt) ?? 0,
    skin: isJsonString(state.skin) ? state.skin : "waymo",
    x,
    y: finiteNum(state.y) ?? 0,
    z,
  };
};

interface RemoteCar {
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
}

/** With an unchanged snapshot, still re-run the sweep this often: distance
 *  culling tracks the moving LOCAL car and idle taxis must age out even when
 *  no net message arrives. Well inside the 60u cull hysteresis band. */
const SWEEP_MS = 500;

interface MovedStamp {
  x: number;
  y: number;
  z: number;
  h: number;
  at: number;
}

/** Shortest signed angle from `from` to `to`, in (-π, π]. */
const shortestAngle = (from: number, to: number): number => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) {
    d -= Math.PI * 2;
  }
  if (d < -Math.PI) {
    d += Math.PI * 2;
  }
  return d;
};

/** Stable bright color from a player id (golden-angle hue hash). */
const colorForId = (id: string): THREE.Color => {
  let h = 2_166_136_261;
  /* oxlint-disable no-bitwise, unicorn/prefer-code-point -- FNV-1a over UTF-16 units: the xor and the uint32 coercion ARE the hash, and codePointAt would recolor every existing peer */
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  const hue = ((h >>> 0) % 360) / 360;
  /* oxlint-enable no-bitwise, unicorn/prefer-code-point */
  return new THREE.Color().setHSL(hue, 0.7, 0.55);
};

export class RemoteCars {
  readonly group = new THREE.Group();
  private cars = new Map<string, RemoteCar>();
  private lastMoved = new Map<string, MovedStamp>();
  private lastPlayers: PlayerMap | null = null;
  private lastSweepAt = 0;
  private scratchN = new THREE.Vector3();
  private quat = new THREE.Quaternion();

  private readonly cache: ModelCache;
  private readonly surface: Surface;
  /** Called when a remote player sends a chat line (bubble goes here). */
  private readonly onChat?: (anchor: THREE.Object3D, text: string) => void;

  constructor(
    cache: ModelCache,
    surface: Surface,
    onChat?: (anchor: THREE.Object3D, text: string) => void,
  ) {
    this.cache = cache;
    this.surface = surface;
    this.onChat = onChat;
  }

  /** Adopt the latest player snapshot; `origin` is the local car for culling. */
  sync(players: PlayerMap, myId: string | null, origin: THREE.Vector3): void {
    const now = performance.now();
    // The client replaces the player map object on every net message — the
    // same reference means nothing changed, so skip the per-player walk
    // (this runs every frame; messages arrive at ~15 Hz).
    if (players === this.lastPlayers && now - this.lastSweepAt < SWEEP_MS) {
      return;
    }
    this.lastPlayers = players;
    this.lastSweepAt = now;
    const seen = new Set<string>();
    for (const [id, player] of Object.entries(players)) {
      if (this.syncPlayer(id, player, myId, now, origin)) {
        seen.add(id);
      }
    }
    for (const [id, car] of this.cars) {
      if (!seen.has(id)) {
        this.remove(id, car);
      }
    }
    for (const id of this.lastMoved.keys()) {
      if (!seen.has(id)) {
        this.lastMoved.delete(id);
      }
    }
  }

  /** One player from the snapshot; false when the id is skipped entirely. */
  private syncPlayer(
    id: string,
    player: PlayerMap[string],
    myId: string | null,
    now: number,
    origin: THREE.Vector3,
  ): boolean {
    if (id === myId) {
      return false;
    }
    const t = readTransform(player.state);
    if (!t) {
      return false;
    }

    let moved = this.lastMoved.get(id);
    if (!moved) {
      moved = { at: now, h: t.h, x: t.x, y: t.y, z: t.z };
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
      if (car) {
        this.remove(id, car);
      }
      return true;
    }
    if (car && car.skin !== t.skin) {
      // player swapped robotaxi — rebuild the body with the new skin
      this.remove(id, car);
      car = undefined;
    }
    if (!car) {
      car = this.spawn(id, t);
    }
    if (t.msg && t.msgAt > car.lastMsgAt) {
      car.lastMsgAt = t.msgAt;
      this.onChat?.(car.group, t.msg);
    }
    car.target.set(t.x, t.y, t.z);
    car.targetHeading = t.h;
    // A big jump is a respawn/reset, not motion — snap instead of streaking
    // the taxi across the map through buildings.
    if (car.cur.distanceToSquared(car.target) > SNAP_DIST_SQ) {
      car.seededPose = true;
    }
    return true;
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
    for (const [id, car] of this.cars) {
      this.remove(id, car);
    }
  }

  // Peer skins are lazy like the player's own: a body whose GLB has not been
  // fetched shows the default Waymo, and every car wearing that skin is
  // dropped once the real one lands so the next sync respawns it correctly.
  // Requested at most once per url — a failed fetch settles and stays settled
  // rather than re-dropping the same cars forever.
  private requestedSkins = new Set<string>();
  private async requestSkin(url: string): Promise<void> {
    if (this.requestedSkins.has(url)) {
      return;
    }
    this.requestedSkins.add(url);
    await this.cache.ensure(url);
    for (const [id, car] of this.cars) {
      if (skinModelUrl(skinById(car.skin)) === url) {
        this.remove(id, car);
      }
    }
  }

  private spawn(id: string, t: RemoteTransform): RemoteCar {
    const group = new THREE.Group();
    group.scale.setScalar(1.12);
    // The sender's chosen robotaxi (Waymo/Zoox/Cybercab/Cruise), sensors and all.
    const skin = skinById(t.skin);
    const url = skinModelUrl(skin);
    if (this.cache.has(url)) {
      group.add(buildSkinBody(this.cache, skin));
    } else {
      void this.requestSkin(url);
      group.add(buildSkinBody(this.cache, skinById(null)));
    }

    // A colored roof beacon so players are told apart in a crowd.
    const beaconGeo = new THREE.SphereGeometry(0.32, 12, 8);
    const beaconMat = new THREE.MeshBasicMaterial({ color: colorForId(id) });
    const beacon = new THREE.Mesh(beaconGeo, beaconMat);
    beacon.position.set(0, 2.1, 0);
    group.add(beacon);

    this.group.add(group);
    const car: RemoteCar = {
      beaconGeo,
      beaconMat,
      cur: new THREE.Vector3(t.x, t.y, t.z),
      curHeading: t.h,
      group,
      // don't replay a bubble that predates our arrival
      lastMsgAt: t.msgAt,
      seededPose: true,
      skin: t.skin,
      target: new THREE.Vector3(t.x, t.y, t.z),
      targetHeading: t.h,
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
