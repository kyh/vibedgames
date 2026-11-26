import * as THREE from "three";

import { Interpolator, RemoteClock, lerp, lerpAngle } from "@vibedgames/multiplayer";
import type { Player, PlayerMap, SenderClock } from "@vibedgames/multiplayer";

import type { ModelCache } from "../assets/loader";

import { isFiniteJsonNumber, isJsonObject, isJsonString } from "../shared/json";
import type { JsonValue } from "../shared/json";
import type { RobotaxiSkin, Surface } from "../vehicle/car";
import { buildSkinBody, skinById, skinModelUrl } from "../vehicle/car";
import { slopeQuaternion } from "../world/terrain";

const RENDER_RADIUS_SQ = 520 * 520;

/** …and only take them out beyond this, so a taxi pacing the boundary doesn't
 *  flicker in and out of the scene. The room's interest radius must clear it
 *  with room to spare, or taxis would pop in view. */
export const DROP_RADIUS = 580;
const DROP_RADIUS_SQ = DROP_RADIUS * DROP_RADIUS;
const SNAP_DIST_SQ = 40 * 40;
const INTERP_DELAY_MS = 100;
const MAX_EXTRAPOLATE_MS = 200;
const INTERP_CAPACITY = 16;
const MAX_COAST_SPAN_MS = 250;
const AWAY_MS = 1500;
const STALE_MS = 15_000;
const AWAY_BEACON = new THREE.Color(0x8a_8f_98);

/** A remote taxi's pose at one instant of the room's server clock. */
export interface RemotePose {
  /** Server time when sent (ms since the epoch — `serverNow()` on every client). */
  t: number;
  x: number;
  y: number;
  z: number;
  h: number;
  /** Planar velocity, world units per second. */
  vx: number;
  vz: number;
}

/** One player-state update, parsed. */
export interface RemoteState extends RemotePose {
  skin: string;
  msg: string;
  msgAt: number;
  paused: boolean;
}

const finiteOr = (v: JsonValue | undefined, fallback: number) =>
  isFiniteJsonNumber(v) ? v : fallback;

/** A peer's player state, or null when it holds no usable transform — or, for
 *  a live peer, no server-clock stamp to place and date it by. A `staged`
 *  trailer pose is drawn exactly as given and carries none. Peers are trusted
 *  for their own car, but a bad one must not feed NaN/Infinity into
 *  slopeQuaternion and the Three.js transforms (which would freeze rendering). */
export const readRemoteState = (state: JsonValue | undefined, staged = false) => {
  if (!isJsonObject(state)) {
    return null;
  }

  const { h, msg, skin, t, x, z } = state;

  if (!isFiniteJsonNumber(x) || !isFiniteJsonNumber(z) || !isFiniteJsonNumber(h)) {
    return null;
  }

  if (!staged && !isFiniteJsonNumber(t)) {
    return null;
  }

  return {
    h,
    msg: isJsonString(msg) ? msg.slice(0, 90) : "",
    msgAt: finiteOr(state.msgAt, 0),
    paused: state.p === 1,
    skin: skinById(isJsonString(skin) ? skin : null).id,
    t: finiteOr(t, 0),
    vx: finiteOr(state.vx, 0),
    vz: finiteOr(state.vz, 0),
    x,
    y: finiteOr(state.y, 0),
    z,
  };
};

/**
 * The Interpolator's blend for remote poses, written into `out`. Between two
 * updates (`alpha` ≤ 1) position and heading are linear — 50 ms of even a
 * tight drift bows less than a few centimetres off the chord. Past the newest
 * update (a late packet) the car coasts along its own velocity, so a taxi that
 * just hit a wall stops instead of sliding into it — but never faster than
 * the pace its last two updates show: the chassis velocity overstates the
 * owner's real pace whenever its sim runs slow (below 30 fps, hit-stop).
 */
export const blendPose = (out: RemotePose, a: RemotePose, b: RemotePose, alpha: number) => {
  if (alpha <= 1) {
    out.t = lerp(a.t, b.t, alpha);
    out.x = lerp(a.x, b.x, alpha);
    out.y = lerp(a.y, b.y, alpha);
    out.z = lerp(a.z, b.z, alpha);
    out.h = lerpAngle(a.h, b.h, alpha);
    out.vx = lerp(a.vx, b.vx, alpha);
    out.vz = lerp(a.vz, b.vz, alpha);

    return out;
  }

  const spanMs = b.t - a.t;

  if (spanMs <= 0 || spanMs > MAX_COAST_SPAN_MS) {
    return b;
  }

  const speed = Math.hypot(b.vx, b.vz);
  const shown = Math.hypot(b.x - a.x, b.z - a.z) / (spanMs / 1000);
  const kept = Math.min(speed, shown);
  const scale = speed > 0 ? kept / speed : 0;
  const pace = shown > 0 ? kept / shown : 0;
  const aheadMs = (alpha - 1) * spanMs;
  out.t = b.t + aheadMs;
  out.x = b.x + (b.vx * scale * aheadMs) / 1000;
  out.y = b.y + (b.y - a.y) * pace * (alpha - 1);
  out.z = b.z + (b.vz * scale * aheadMs) / 1000;
  out.h = lerpAngle(a.h, b.h, 1 + pace * (alpha - 1));
  out.vx = b.vx;
  out.vz = b.vz;

  return out;
};

const colorForId = (id: string) => {
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

interface View {
  readonly group: THREE.Group;
  body: THREE.Object3D;
  template: THREE.Object3D;
  skin: string;
  dressedAt: number;
  readonly beaconMat: THREE.MeshBasicMaterial;
  readonly color: THREE.Color;
  away: boolean;
  attached: boolean;
}

interface Peer {
  readonly id: string;
  source: Player["state"];
  latest: RemoteState;
  readonly clock: RemoteClock;
  readonly interp: Interpolator<RemotePose>;
  connected: boolean;
  rejoining: boolean;
  lastMsgAt: number;
  chat: string | null;
  generation: number;
  view: View | null;
}

export interface SyncOptions {
  /** The trailer director's fake players: poses written every frame, shown as given. */
  staged?: boolean;
  /** Local time of this frame: when what it brings arrived, for the relay clocks. */
  now?: number;
}

export class RemoteCars {
  readonly group = new THREE.Group();
  /** Trailer-staged rivals carry no player beacon; cars spawned after a change pick it up. */
  showBeacons = true;

  private readonly peers = new Map<string, Peer>();
  private readonly bodies = new Map<string, THREE.Object3D>();
  private readonly requestedSkins = new Set<string>();
  private readonly beaconGeo = new THREE.SphereGeometry(0.32, 12, 8);
  private readonly scratchN = new THREE.Vector3();
  private lastPlayers: PlayerMap | null = null;
  private generation = 0;
  private staged = false;
  private visible = 0;
  private skinLoads = 0;

  private readonly cache: ModelCache;
  private readonly surface: Surface;
  private readonly clock: SenderClock;
  private readonly onChat?: (anchor: THREE.Object3D, text: string) => void;
  private readonly build: (skin: RobotaxiSkin) => THREE.Object3D;

  constructor(
    cache: ModelCache,
    surface: Surface,
    clock: SenderClock,
    onChat?: (anchor: THREE.Object3D, text: string) => void,
    build: (skin: RobotaxiSkin) => THREE.Object3D = (skin) => buildSkinBody(cache, skin),
  ) {
    this.cache = cache;
    this.surface = surface;
    this.clock = clock;
    this.onChat = onChat;
    this.build = build;
  }

  /** Adopt the room's player map. The client replaces the map object on every
   *  net message, so the same reference means nothing changed and is skipped
   *  outright (this runs every frame). */
  sync(players: PlayerMap, myId: string | null, options: SyncOptions = {}) {
    if (players === this.lastPlayers) {
      return;
    }

    this.lastPlayers = players;
    this.staged = options.staged === true;
    const now = options.now ?? performance.now();
    this.generation += 1;

    for (const id of Object.keys(players)) {
      const player = players[id];

      if (player && id !== myId && player.visible !== false) {
        this.adopt(id, player, now);
      }
    }

    for (const peer of this.peers.values()) {
      if (peer.generation !== this.generation) {
        this.drop(peer);
      }
    }
  }

  /** Place this frame's taxis; `origin` is the local car, for culling. */
  update(origin: THREE.Vector3, now: number = performance.now()) {
    const serverNow = this.clock.now(now);
    let visible = 0;

    for (const peer of this.peers.values()) {
      const dx = peer.latest.x - origin.x;
      const dz = peer.latest.z - origin.z;
      const radiusSq = peer.view?.attached === true ? DROP_RADIUS_SQ : RENDER_RADIUS_SQ;

      if (this.present(peer, serverNow) && dx * dx + dz * dz <= radiusSq) {
        this.place(peer, now, serverNow);
        visible += 1;
      } else {
        this.hide(peer);
      }
    }

    this.visible = visible;
  }

  /** Every present player's newest position in interest range, on screen or
   *  not (the minimap). */
  forEachPresent(visit: (x: number, z: number) => void, now: number = performance.now()) {
    const serverNow = this.clock.now(now);

    for (const peer of this.peers.values()) {
      if (this.present(peer, serverNow)) {
        visit(peer.latest.x, peer.latest.z);
      }
    }
  }

  /** Taxis in the scene as of the last update. */
  count() {
    return this.visible;
  }

  /** Back in the room after our own connection dropped: every owner's
   *  updates now reach us by a new route, which each clock measures afresh. */
  relearn() {
    for (const peer of this.peers.values()) {
      peer.clock.relearn();
    }
  }

  dispose() {
    for (const peer of this.peers.values()) {
      this.drop(peer);
    }

    this.beaconGeo.dispose();
    this.lastPlayers = null;
  }

  private present(peer: Peer, serverNow: number) {
    return (
      this.staged ||
      (peer.connected &&
        !peer.rejoining &&
        this.clock.synced &&
        serverNow - peer.latest.t <= STALE_MS)
    );
  }

  private place(peer: Peer, now: number, serverNow: number) {
    const { latest } = peer;
    let { view } = peer;

    if (!view) {
      view = this.makeView(peer);
      peer.view = view;
    } else if (view.skin !== latest.skin || view.dressedAt !== this.skinLoads) {
      this.dress(view, latest.skin);
    }

    if (!view.attached) {
      this.group.add(view.group);
      view.attached = true;
    }

    const away = latest.paused || (!this.staged && serverNow - latest.t > AWAY_MS);

    if (away !== view.away) {
      view.away = away;
      view.beaconMat.color.copy(away ? AWAY_BEACON : view.color);
    }

    const pose = this.staged ? latest : (peer.interp.sample(now) ?? latest);
    const n = this.surface.normalInto(this.scratchN, pose.x, pose.z);
    slopeQuaternion(view.group.quaternion, pose.h, n);
    view.group.position.set(pose.x, pose.y, pose.z);

    if (peer.chat !== null) {
      this.onChat?.(view.group, peer.chat);
      peer.chat = null;
    }
  }

  private hide(peer: Peer) {
    const { view } = peer;

    if (view?.attached === true) {
      this.group.remove(view.group);
      view.attached = false;
    }

    peer.chat = null;
  }

  private adopt(id: string, player: Player, now: number) {
    const known = this.peers.get(id);
    const connected = player.connected !== false;

    if (known !== undefined && connected && !known.connected) {
      known.clock.relearn();
      known.rejoining = true;
    }

    if (known !== undefined && known.source === player.state) {
      known.connected = connected;
      known.generation = this.generation;

      return;
    }

    const next = readRemoteState(player.state, this.staged);

    if (!next) {
      if (known) {
        this.drop(known);
      }

      return;
    }

    const peer = known ?? this.track(id, next, now);

    if (known) {
      this.advance(known, next, now);
    }

    peer.source = player.state;
    peer.connected = connected;
    peer.generation = this.generation;
  }

  private track(id: string, first: RemoteState, now: number) {
    const out: RemotePose = { h: 0, t: 0, vx: 0, vz: 0, x: 0, y: 0, z: 0 };
    const clock = new RemoteClock();

    const interp = new Interpolator<RemotePose>({
      capacity: INTERP_CAPACITY,
      clock,
      delayMs: INTERP_DELAY_MS,
      lerp: (a, b, alpha) => blendPose(out, a, b, alpha),
      maxExtrapolateMs: MAX_EXTRAPOLATE_MS,
    });

    if (!this.staged) {
      interp.push(first.t, first, now);
    }

    const peer: Peer = {
      chat: null,
      clock,
      connected: true,
      generation: this.generation,
      id,
      interp,
      lastMsgAt: first.msgAt,
      latest: first,
      rejoining: false,
      source: undefined,
      view: null,
    };

    this.peers.set(id, peer);

    return peer;
  }

  private advance(peer: Peer, next: RemoteState, now: number) {
    const prev = peer.latest;

    if (!this.staged && next.t !== prev.t) {
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;

      if (peer.rejoining || dx * dx + dz * dz > SNAP_DIST_SQ || next.t - prev.t > STALE_MS) {
        peer.interp.clear();
      }

      peer.rejoining = false;
      peer.interp.push(next.t, next, now);
    }

    if (next.msg && next.msgAt > peer.lastMsgAt) {
      peer.lastMsgAt = next.msgAt;
      peer.chat = next.msg;
    }

    peer.latest = next;
  }

  private makeView(peer: Peer) {
    const group = new THREE.Group();
    group.scale.setScalar(1.12);
    const template = this.template(peer.latest.skin);
    const body = template.clone();
    group.add(body);
    const color = colorForId(peer.id);
    const beaconMat = new THREE.MeshBasicMaterial({ color });
    const beacon = new THREE.Mesh(this.beaconGeo, beaconMat);
    beacon.position.set(0, 2.1, 0);
    beacon.visible = this.showBeacons;
    group.add(beacon);

    return {
      attached: false,
      away: false,
      beaconMat,
      body,
      color,
      dressedAt: this.skinLoads,
      group,
      skin: peer.latest.skin,
      template,
    };
  }

  private dress(view: View, skin: string) {
    view.skin = skin;
    view.dressedAt = this.skinLoads;
    const template = this.template(skin);

    if (template === view.template) {
      return;
    }

    view.group.remove(view.body);
    view.template = template;
    view.body = template.clone();
    view.group.add(view.body);
  }

  private template(skinId: string) {
    let skin = skinById(skinId);
    const url = skinModelUrl(skin);

    if (!this.cache.has(url)) {
      void this.requestSkin(url);
      skin = skinById(null);
    }

    let body = this.bodies.get(skin.id);

    if (!body) {
      body = this.build(skin);
      this.bodies.set(skin.id, body);
    }

    return body;
  }

  private async requestSkin(url: string) {
    if (this.requestedSkins.has(url)) {
      return;
    }

    this.requestedSkins.add(url);
    await this.cache.ensure(url);
    this.skinLoads += 1;
  }

  private drop(peer: Peer) {
    const { view } = peer;

    if (view) {
      this.group.remove(view.group);
      view.beaconMat.dispose();
    }

    this.peers.delete(peer.id);
  }
}
