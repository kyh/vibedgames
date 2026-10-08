// Renders the other players' taxis in the shared free-roam city. The world is
// generated from a fixed CITY_SEED, so every client already builds an identical
// map — remote cars just need their networked transforms placed on it. Every
// owner stamps its pose with the room's server clock (GameScene.updateNet),
// which every client shares: a car is drawn INTERP_DELAY_MS behind that clock,
// blended between the two updates around that moment, so it moves as smoothly
// as it was driven however unevenly the updates arrive — and the stamp dates
// the pose, so a taxi whose newest one is old reads as away, then gone. Cars
// are distance-culled so a full 64-player room stays cheap (only nearby taxis
// are in the scene).

import * as THREE from "three";

import { Interpolator, lerp, lerpAngle } from "@vibedgames/multiplayer";
import type { Player, PlayerMap, SenderClock } from "@vibedgames/multiplayer";

import type { ModelCache } from "../assets/loader";

import { isFiniteJsonNumber, isJsonObject, isJsonString } from "../shared/json";
import type { JsonValue } from "../shared/json";
import type { RobotaxiSkin, Surface } from "../vehicle/car";
import { buildSkinBody, skinById, skinModelUrl } from "../vehicle/car";
import { slopeQuaternion } from "../world/terrain";

/** Put taxis in the scene inside this radius (matches the city's DETAIL_DISTANCE
 *  so cars don't pop against still-visible props)… */
const RENDER_RADIUS_SQ = 520 * 520;
/** …and only take them out beyond this, so a taxi pacing the boundary doesn't
 *  flicker in and out of the scene. */
const DROP_RADIUS_SQ = 580 * 580;
/** Consecutive updates farther apart than this are a respawn/reset — snap,
 *  don't streak the taxi across the map through buildings. */
const SNAP_DIST_SQ = 40 * 40;
/** How far behind the server clock a car is drawn. A stamp is already one
 *  sender → server → receiver trip old when it lands (~50–150 ms), and the
 *  update after it a 20 Hz interval later still: 200 ms keeps both updates
 *  around the drawn moment in hand on such a link. (A clock estimated per
 *  sender absorbs the trip and gets by on 100; the shared one cannot.) */
const INTERP_DELAY_MS = 200;
/** A late update is covered by coasting this long; after that the car holds. */
const MAX_EXTRAPOLATE_MS = 200;
/** Updates kept per car — several times the delay at 20 Hz. */
const INTERP_CAPACITY = 16;
/** Two updates further apart than this bracket a silence, not motion: never
 *  coast on the pace measured across one. */
const MAX_COAST_SPAN_MS = 250;
/** A newest pose stamped this long ago reads as away (grey beacon)… */
const AWAY_MS = 1500;
/** …and this long ago, gone. Owners keep sending while parked or paused, so
 *  only a hidden tab (socket open, rAF stopped) or a dead link goes quiet; the
 *  car comes back the moment it speaks again. */
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

const finiteOr = (v: JsonValue | undefined, fallback: number): number =>
  isFiniteJsonNumber(v) ? v : fallback;

/** A peer's player state, or null when it holds no usable transform — or, for
 *  a live peer, no server-clock stamp to place and date it by. A `staged`
 *  trailer pose is drawn exactly as given and carries none. Peers are trusted
 *  for their own car, but a bad one must not feed NaN/Infinity into
 *  slopeQuaternion and the Three.js transforms (which would freeze rendering). */
export const readRemoteState = (
  state: JsonValue | undefined,
  staged = false,
): RemoteState | null => {
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
export const blendPose = (
  out: RemotePose,
  a: RemotePose,
  b: RemotePose,
  alpha: number,
): RemotePose => {
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
  // `scale` trims the velocity vector to the shown pace; `pace` is the share
  // of the last interval's motion (climb, turn) that continues with it.
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

interface View {
  readonly group: THREE.Group;
  body: THREE.Object3D;
  /** The shared per-skin body this one was cloned from. */
  template: THREE.Object3D;
  /** The skin asked for when dressed, and `skinLoads` then: either moving on
   *  means the body may need re-dressing. */
  skin: string;
  dressedAt: number;
  readonly beaconMat: THREE.MeshBasicMaterial;
  readonly color: THREE.Color;
  away: boolean;
  attached: boolean;
}

interface Peer {
  readonly id: string;
  /** The player-state object last parsed — the client replaces it whenever
   *  that player's state changes, so the same object means nothing new. */
  source: Player["state"];
  latest: RemoteState;
  readonly interp: Interpolator<RemotePose>;
  connected: boolean;
  lastMsgAt: number;
  /** A chat line to show if the car is on screen this frame. */
  chat: string | null;
  generation: number;
  view: View | null;
}

export interface SyncOptions {
  /** The trailer director's fake players: poses written every frame, shown as given. */
  staged?: boolean;
}

export class RemoteCars {
  readonly group = new THREE.Group();
  /** Trailer-staged rivals carry no player beacon; cars spawned after a change pick it up. */
  showBeacons = true;

  private readonly peers = new Map<string, Peer>();
  /** One body per skin, cloned for every car wearing it — see `template`. */
  private readonly bodies = new Map<string, THREE.Object3D>();
  private readonly requestedSkins = new Set<string>();
  private readonly beaconGeo = new THREE.SphereGeometry(0.32, 12, 8);
  private readonly scratchN = new THREE.Vector3();
  private lastPlayers: PlayerMap | null = null;
  private generation = 0;
  private staged = false;
  private visible = 0;
  /** Bumped whenever a lazily fetched skin settles. */
  private skinLoads = 0;

  private readonly cache: ModelCache;
  private readonly surface: Surface;
  /** The room's server clock: what every pose is stamped, drawn and dated by. */
  private readonly clock: SenderClock;
  /** Called when a remote player sends a chat line (bubble goes here). */
  private readonly onChat?: (anchor: THREE.Object3D, text: string) => void;
  /** Builds a skin's body; headless tests pass a stand-in (the real one bakes
   *  canvas textures). */
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
  sync(players: PlayerMap, myId: string | null, options: SyncOptions = {}): void {
    if (players === this.lastPlayers) {
      return;
    }
    this.lastPlayers = players;
    this.staged = options.staged === true;
    this.generation += 1;
    for (const id of Object.keys(players)) {
      const player = players[id];
      if (player && id !== myId) {
        this.adopt(id, player);
      }
    }
    for (const peer of this.peers.values()) {
      if (peer.generation !== this.generation) {
        this.drop(peer);
      }
    }
  }

  /** Place this frame's taxis; `origin` is the local car, for culling. */
  update(origin: THREE.Vector3, now: number = performance.now()): void {
    const serverNow = this.clock.now(now);
    let visible = 0;
    for (const peer of this.peers.values()) {
      const dx = peer.latest.x - origin.x;
      const dz = peer.latest.z - origin.z;
      const radiusSq = peer.view?.attached ? DROP_RADIUS_SQ : RENDER_RADIUS_SQ;
      if (this.present(peer, serverNow) && dx * dx + dz * dz <= radiusSq) {
        this.place(peer, now, serverNow);
        visible += 1;
      } else {
        this.hide(peer);
      }
    }
    this.visible = visible;
  }

  /** Every present player's newest position, near or far (the minimap). */
  forEachPresent(visit: (x: number, z: number) => void, now: number = performance.now()): void {
    const serverNow = this.clock.now(now);
    for (const peer of this.peers.values()) {
      if (this.present(peer, serverNow)) {
        visit(peer.latest.x, peer.latest.z);
      }
    }
  }

  /** Taxis in the scene as of the last update. */
  count(): number {
    return this.visible;
  }

  dispose(): void {
    for (const peer of this.peers.values()) {
      this.drop(peer);
    }
    this.beaconGeo.dispose();
    this.lastPlayers = null;
  }

  /** Connected with a pose stamped within STALE_MS — or staged, which holds
   *  until replaced. Until this client has measured the server clock it reads
   *  the local one, which dates no stamp, so nothing live is present yet. */
  private present(peer: Peer, serverNow: number): boolean {
    return (
      this.staged || (peer.connected && this.clock.synced && serverNow - peer.latest.t <= STALE_MS)
    );
  }

  private place(peer: Peer, now: number, serverNow: number): void {
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

  /** Out of the scene, not torn down: the body comes back with a re-add. */
  private hide(peer: Peer): void {
    const { view } = peer;
    if (view?.attached) {
      this.group.remove(view.group);
      view.attached = false;
    }
    peer.chat = null;
  }

  private adopt(id: string, player: Player): void {
    const known = this.peers.get(id);
    const connected = player.connected !== false;
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
    const peer = known ?? this.track(id, next);
    if (known) {
      this.advance(known, next);
    }
    peer.source = player.state;
    peer.connected = connected;
    peer.generation = this.generation;
  }

  /** First sight of a player: its pose goes straight in. The room's copy of a
   *  hidden tab's pose can be minutes old, but its stamp says so — such a car
   *  is never present, and shows once its owner speaks again. */
  private track(id: string, first: RemoteState): Peer {
    // The blend writes here every frame instead of allocating a pose.
    const out: RemotePose = { h: 0, t: 0, vx: 0, vz: 0, x: 0, y: 0, z: 0 };
    const interp = new Interpolator<RemotePose>({
      capacity: INTERP_CAPACITY,
      clock: this.clock,
      delayMs: INTERP_DELAY_MS,
      lerp: (a, b, alpha) => blendPose(out, a, b, alpha),
      maxExtrapolateMs: MAX_EXTRAPOLATE_MS,
    });
    if (!this.staged) {
      interp.push(first.t, first);
    }
    const peer: Peer = {
      chat: null,
      connected: true,
      generation: this.generation,
      id,
      interp,
      // Don't replay a bubble that predates our arrival.
      lastMsgAt: first.msgAt,
      latest: first,
      source: undefined,
      view: null,
    };
    this.peers.set(id, peer);
    return peer;
  }

  private advance(peer: Peer, next: RemoteState): void {
    const prev = peer.latest;
    if (!this.staged && next.t !== prev.t) {
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      // A respawn, or an owner back from a long silence: show the new pose at
      // once instead of gliding there from the old one.
      if (dx * dx + dz * dz > SNAP_DIST_SQ || next.t - prev.t > STALE_MS) {
        peer.interp.clear();
      }
      peer.interp.push(next.t, next);
    }
    if (next.msg && next.msgAt > peer.lastMsgAt) {
      peer.lastMsgAt = next.msgAt;
      peer.chat = next.msg;
    }
    peer.latest = next;
  }

  private makeView(peer: Peer): View {
    const group = new THREE.Group();
    group.scale.setScalar(1.12);
    const template = this.template(peer.latest.skin);
    const body = template.clone();
    group.add(body);
    // A colored roof beacon so players are told apart in a crowd.
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

  /** Swap the body for the skin's (a skin change, or its GLB just landed). */
  private dress(view: View, skin: string): void {
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

  /**
   * The body every car wearing `skinId` is cloned from: clones share its
   * geometry and materials, so a car entering view, coming back or swapping
   * skins costs a clone — never another set of lacquer materials and sensor
   * geometry, which nothing would dispose. Built once per skin (bounded by the
   * roster) and kept for the session. Peer skins are lazy like the player's
   * own: until a skin's GLB is fetched the default Waymo stands in, and every
   * car re-dresses once it lands (`skinLoads`).
   */
  private template(skinId: string): THREE.Object3D {
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

  // Requested at most once per url: a failed fetch settles and stays settled
  // (its cars keep the stand-in) rather than retrying forever.
  private async requestSkin(url: string): Promise<void> {
    if (this.requestedSkins.has(url)) {
      return;
    }
    this.requestedSkins.add(url);
    await this.cache.ensure(url);
    this.skinLoads += 1;
  }

  private drop(peer: Peer): void {
    const { view } = peer;
    if (view) {
      this.group.remove(view.group);
      // The body is a clone of a shared template; only the beacon material is this car's own.
      view.beaconMat.dispose();
    }
    this.peers.delete(peer.id);
  }
}
