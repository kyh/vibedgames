// Remote-car netcode, headless: real RemoteCars and Interpolator, fed by
// simulated drivers (a 60 fps loop sending on a 20 Hz FixedRate, each update
// stamped with the room's server clock and delivered in order after a jittered
// relay through the server) and read back at 60 fps — the way a peer's browser
// sees them. Cars are drawn on each owner's relay clock, learnt from arrival
// times; the receiver's measurement of the server clock only dates poses.
import { setTimeout as settle } from "node:timers/promises";

import * as THREE from "three";
import { FixedRate } from "@vibedgames/multiplayer";
import type { PlayerMap } from "@vibedgames/multiplayer";

import { ModelCache } from "../src/assets/loader.ts";
import { blendPose, DROP_RADIUS, readRemoteState, RemoteCars } from "../src/net/remote-cars.ts";
import type { RemotePose } from "../src/net/remote-cars.ts";
import { CAR, MP_INTEREST } from "../src/shared/constants.ts";
import type { JsonObject } from "../src/shared/json.ts";
import { skinById, skinModelUrl } from "../src/vehicle/car.ts";
import type { Surface } from "../src/vehicle/car.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;

const FRAME_MS = 1000 / 60;
/** The receiver's local clock minus the server's: performance.now() has no epoch. */
const SKEW_MS = 7000;
/** How far ahead of the true server time the receiver's measurement reads. */
const CLOCK_ERROR_MS = 6;

/** Deterministic jitter in [0, 1) so the checks never flake. */
const noise = (i: number): number => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;
  return s - Math.floor(s);
};

const flat: Surface = { heightAt: () => 0, normalInto: (out) => out.set(0, 1, 0) };

/** The default body is loaded at boot; any other skin lands a microtask after it is asked for. */
const stubCache = (): ModelCache => {
  const cache = new ModelCache();
  const loaded = new Set([skinModelUrl(skinById(null))]);
  cache.has = (url) => loaded.has(url);
  cache.ensure = (url) => {
    loaded.add(url);
    return Promise.resolve();
  };
  return cache;
};

interface Packet {
  arrive: number;
  id: string;
  state: JsonObject;
}

/**
 * One remote driver from server time `fromMs` to `toMs`: `pose` is its car
 * (null while its tab is hidden and nothing goes out), stamped with the
 * server clock and delivered in order after `latency(i)` ms — the whole trip,
 * sender to server to receiver.
 */
const drive = (
  id: string,
  fromMs: number,
  toMs: number,
  pose: (ms: number) => JsonObject | null,
  latency: (i: number) => number = () => 40,
): Packet[] => {
  const rate = new FixedRate(20);
  const packets: Packet[] = [];
  let lastArrive = 0;
  for (let ms = fromMs; ms <= toMs; ms += FRAME_MS) {
    const state = rate.due(FRAME_MS) ? pose(ms) : null;
    if (state) {
      const arrive = Math.max(lastArrive, ms + SKEW_MS + latency(packets.length));
      lastArrive = arrive;
      packets.push({ arrive, id, state: { ...state, t: Math.round(ms) } });
    }
  }
  return packets;
};

const cruise =
  (speed: number, x0 = 0) =>
  (ms: number): JsonObject => ({
    h: Math.PI / 2,
    skin: "waymo",
    vx: speed,
    vz: 0,
    x: x0 + (speed * ms) / 1000,
    y: 0,
    z: 0,
  });

const parkedAt = (x: number, extra: JsonObject = {}): JsonObject => ({
  h: 0,
  skin: "waymo",
  vx: 0,
  vz: 0,
  x,
  y: 0,
  z: 0,
  ...extra,
});

/** A receiver: the client's mirror of the room (every update merges into a
 *  fresh state object and a fresh map, as MultiplayerClient does) driving a
 *  RemoteCars at 60 fps. */
class Receiver {
  players: PlayerMap = {};
  now = SKEW_MS;
  /** This receiver's measurement of the server clock: until a probe has come
   *  back (`synced` false) it reads the local clock, as ServerClock does. */
  readonly clock = {
    now: (localNow = 0): number =>
      this.clock.synced ? localNow - SKEW_MS + CLOCK_ERROR_MS : localNow,
    synced: true,
  };
  readonly builds: string[] = [];
  readonly chats: string[] = [];
  readonly origin = new THREE.Vector3();
  readonly remote = new RemoteCars(
    stubCache(),
    flat,
    this.clock,
    (_anchor, text) => {
      this.chats.push(text);
    },
    (skin) => {
      this.builds.push(skin.id);
      const body = new THREE.Group();
      body.name = skin.id;
      return body;
    },
  );
  private queue: Packet[] = [];

  send(packets: readonly Packet[]): void {
    this.queue = [...this.queue, ...packets].toSorted((a, b) => a.arrive - b.arrive);
  }

  patch(id: string, state: JsonObject): void {
    const existing = this.players[id];
    this.players = {
      ...this.players,
      [id]: { ...existing, id, state: { ...existing?.state, ...state } },
    };
  }

  setConnected(id: string, connected: boolean): void {
    const existing = this.players[id];
    if (existing) {
      this.players = { ...this.players, [id]: { ...existing, connected } };
    }
  }

  /** The server's interest verdict on a player (`player_visibility`). */
  setVisible(id: string, visible: boolean): void {
    const existing = this.players[id];
    if (existing) {
      this.players = { ...this.players, [id]: { ...existing, visible } };
    }
  }

  /** Run frames up to receiver time `until`; `probe` sees each one after update. */
  run(until: number, probe?: (now: number) => void): void {
    for (; this.now <= until; this.now += FRAME_MS) {
      while (this.queue.length > 0 && (this.queue[0]?.arrive ?? Infinity) <= this.now) {
        const packet = this.queue.shift();
        if (packet) {
          this.patch(packet.id, packet.state);
        }
      }
      this.remote.sync(this.players, "me", { now: this.now });
      this.remote.update(this.origin, this.now);
      probe?.(this.now);
    }
  }

  /** The n-th taxi in the scene. */
  car(n = 0): THREE.Object3D | undefined {
    return this.remote.group.children[n];
  }

  present(): number {
    let n = 0;
    this.remote.forEachPresent(() => {
      n += 1;
    }, this.now);
    return n;
  }
}

const bodyOf = (car: THREE.Object3D | undefined): THREE.Object3D | undefined =>
  car?.children.find((c) => !(c instanceof THREE.Mesh));

const beaconHex = (car: THREE.Object3D | undefined): number | null => {
  const beacon = car?.children.find((c) => c instanceof THREE.Mesh);
  return beacon instanceof THREE.Mesh && beacon.material instanceof THREE.MeshBasicMaterial
    ? beacon.material.color.getHex()
    : null;
};

const checkWireFormat = (check: Check): void => {
  const parsed = readRemoteState({
    h: 1,
    p: 1,
    skin: "zoox",
    t: 1234,
    vx: 3,
    vz: -4,
    x: 10,
    y: 2,
    z: -5,
  });
  check(
    "remote state reads the stamp, velocity, pause flag and skin",
    parsed?.t === 1234 &&
      parsed.vx === 3 &&
      parsed.vz === -4 &&
      parsed.paused &&
      parsed.skin === "zoox",
  );
  check(
    "a live state without a server-clock stamp is no car",
    readRemoteState({ h: 0, skin: "waymo", x: 1, z: 2 }) === null,
  );
  const staged = readRemoteState({ h: 0, skin: "nonsense", x: 1, z: 2 }, true);
  check(
    "a staged pose needs no stamp, and an unknown skin is the default",
    staged?.skin === "waymo" && staged.vx === 0,
  );
  check(
    "a state without a finite transform is no car",
    readRemoteState({ h: 0, t: 1, x: 1 }) === null &&
      readRemoteState({ h: 0, t: 1, x: "1", z: 2 }) === null &&
      readRemoteState(null) === null,
  );
};

const pose = (t: number, x: number, vx: number, h = 0): RemotePose => ({
  h,
  t,
  vx,
  vz: 0,
  x,
  y: 0,
  z: 0,
});

const checkBlend = (check: Check): void => {
  const out = pose(0, 0, 0);
  const mid = blendPose(out, pose(0, 0, 30, 3), pose(50, 1.5, 30, -3), 0.5);
  check(
    "between updates a pose blends linearly, heading along the short arc",
    Math.abs(mid.x - 0.75) < 1e-9 && Math.abs(Math.abs(mid.h) - Math.PI) < 0.15,
    `x ${mid.x.toFixed(3)}, h ${mid.h.toFixed(3)}`,
  );
  // 100 ms past the newest update.
  const cruising = blendPose(out, pose(0, 0, 30), pose(50, 1.5, 30), 3).x;
  check("a late update coasts along the velocity", Math.abs(cruising - 4.5) < 1e-9, `${cruising}`);
  const crashed = blendPose(out, pose(0, 0, 30), pose(50, 1.5, 0), 3).x;
  check(
    "a taxi that stopped dead (wall hit) does not coast on its old speed",
    crashed === 1.5,
    `${crashed}`,
  );
  // Sim at half speed (owner below 30 fps): 0.75 u per 50 ms, chassis says 30 u/s.
  const slowMo = blendPose(out, pose(0, 0, 30), pose(50, 0.75, 30), 3).x;
  check(
    "a slowed owner coasts at the pace its updates show, not its chassis speed",
    Math.abs(slowMo - 2.25) < 1e-9,
    `${slowMo}`,
  );
  const bridged = blendPose(out, pose(0, 0, 30), pose(5000, 3, 30), 1.5).x;
  check("never coast on a pace measured across a silence", bridged === 3, `${bridged}`);
};

/** A taxi cruising at 30 u/s over a link whose trip through the server takes
 *  `fromMs` plus up to `spreadMs` of jitter, read back at 60 fps. */
const cruiseOver = (fromMs: number, spreadMs: number) => {
  const rx = new Receiver();
  const speed = 30;
  rx.send(drive("a", 0, 9000, cruise(speed), (i) => fromMs + spreadMs * noise(i)));
  let prev: number | null = null;
  let minStep = Infinity;
  let maxStep = 0;
  let backwards = 0;
  let lagMs = 0;
  rx.run(SKEW_MS + 8500, (now) => {
    const x = rx.car()?.position.x;
    if (x === undefined) {
      return;
    }
    if (prev !== null && now > SKEW_MS + 1500) {
      const step = (x - prev) / ((speed * FRAME_MS) / 1000);
      minStep = Math.min(minStep, step);
      maxStep = Math.max(maxStep, step);
      backwards += x < prev - 1e-6 ? 1 : 0;
      lagMs = ((speed * (now - SKEW_MS)) / 1000 - x) / (speed / 1000);
    }
    prev = x;
  });
  return { backwards, lagMs, maxStep, minStep };
};

const checkSmoothMotion = (check: Check): void => {
  // 40–140 ms through the server: jitter twice the 50 ms send interval.
  const typical = cruiseOver(40, 100);
  check(
    "a remote taxi on a jittery link moves at its true speed every frame",
    typical.minStep > 0.8 && typical.maxStep < 1.2,
    `per-frame speed ${(typical.minStep * 100).toFixed(0)}–${(typical.maxStep * 100).toFixed(0)}% of true`,
  );
  check("a remote taxi cruising straight never rubber-bands backwards", typical.backwards === 0);
  // Behind its fastest relay (40 ms) by the 100 ms render delay, or by as
  // much as the link's lateness needs: each 50 ms interval plus the 100 ms
  // spread, plus the frame an arrival waits to be read.
  check(
    "a remote taxi trails its owner by its fastest relay plus what its link's lateness needs",
    typical.lagMs > 40 + 100 && typical.lagMs < 40 + 50 + 100 + FRAME_MS,
    `${typical.lagMs.toFixed(0)} ms behind`,
  );
  // 150–250 ms: the owner's relay clock learns the slower route, so the car
  // trails by the extra 110 ms instead of running dry and stalling.
  const slow = cruiseOver(150, 100);
  check(
    "a slow route is learnt per owner: the car trails further but moves just as smoothly",
    slow.minStep > 0.8 &&
      slow.maxStep < 1.2 &&
      slow.backwards === 0 &&
      Math.abs(slow.lagMs - typical.lagMs - 110) < 20,
    `per-frame speed ${(slow.minStep * 100).toFixed(0)}–${(slow.maxStep * 100).toFixed(0)}% of true, ${slow.lagMs.toFixed(0)} ms behind`,
  );
};

const checkPresence = (check: Check): void => {
  // Parked for 40 s: only the stamp changes on the wire.
  const parked = new Receiver();
  parked.send(drive("p", 0, 40_000, () => parkedAt(30)));
  let gone = 0;
  parked.run(SKEW_MS + 40_000, (now) => {
    gone += now > SKEW_MS + 500 && parked.remote.count() === 0 ? 1 : 0;
  });
  check(
    "a parked player stays in everyone's city (presence is the stamp, not motion)",
    gone === 0 && parked.present() === 1,
  );

  // A hidden tab: two seconds of driving, silence, then back 10 u further on.
  const rx = new Receiver();
  rx.send(drive("h", 0, 2000, () => parkedAt(50)));
  rx.send(drive("h", 25_000, 26_000, () => parkedAt(60)));
  let colour: number | null = null;
  rx.run(SKEW_MS + 1500, () => {
    colour = beaconHex(rx.car());
  });
  rx.run(SKEW_MS + 2000 + 1700);
  const awayColour = beaconHex(rx.car());
  rx.run(SKEW_MS + 2000 + 14_000);
  const stillThere = rx.remote.count();
  rx.run(SKEW_MS + 2000 + 15_200);
  check(
    "a silent player greys out, then leaves the city and the minimap after 15 s",
    colour !== null &&
      awayColour !== colour &&
      stillThere === 1 &&
      rx.remote.count() === 0 &&
      rx.present() === 0,
  );
  let back: number | undefined;
  rx.run(SKEW_MS + 25_000 + 200, () => {
    back ??= rx.car()?.position.x;
  });
  check(
    "a returning player shows at once where they are, not gliding from where they left",
    back === 60 && beaconHex(rx.car()) === colour,
    `${back}`,
  );

  rx.send(drive("h", 26_000, 30_000, () => parkedAt(60)));
  rx.run(SKEW_MS + 27_000);
  rx.setConnected("h", false);
  rx.run(rx.now + 1);
  const dropped = rx.remote.count();
  rx.setConnected("h", true);
  rx.run(rx.now + 1);
  check(
    "a dropped connection hides the taxi at once; reconnecting restores it",
    dropped === 0 && rx.remote.count() === 1,
  );

  // Joining a room that still holds a hidden tab's last pose, a minute old.
  const late = new Receiver();
  late.patch("old", { ...parkedAt(5), t: -60_000 });
  late.run(SKEW_MS + 3000);
  const ghost = late.remote.count() + late.present();
  const spoke = Math.round(late.now - SKEW_MS);
  late.send([{ arrive: late.now, id: "old", state: { ...parkedAt(5), t: spoke } }]);
  late.run(late.now + 1);
  check(
    "a stale pose found on joining shows only once its owner speaks",
    ghost === 0 && late.remote.count() === 1,
  );

  // Joining a room mid-drive: the sync holds a pose stamped a moment ago.
  const joiner = new Receiver();
  joiner.patch("live", { ...parkedAt(5), t: -80 });
  joiner.run(SKEW_MS);
  check(
    "a current pose found on joining shows at once, without waiting for the next",
    joiner.remote.count() === 1,
  );

  // The receiver's first clock probe is still out: stamps cannot be dated yet.
  const unsynced = new Receiver();
  unsynced.clock.synced = false;
  unsynced.send(drive("u", 0, 2000, () => parkedAt(5)));
  unsynced.run(SKEW_MS + 1000);
  const early = unsynced.remote.count() + unsynced.present();
  unsynced.clock.synced = true;
  unsynced.run(SKEW_MS + 1100);
  check(
    "nothing live shows before this client has measured the server clock",
    early === 0 && unsynced.remote.count() === 1,
  );

  const pausedRx = new Receiver();
  pausedRx.send(drive("z", 0, 1000, () => parkedAt(20)));
  pausedRx.send(drive("z", 1000, 3000, () => parkedAt(20, { p: 1 })));
  pausedRx.run(SKEW_MS + 900);
  const live = beaconHex(pausedRx.car());
  pausedRx.run(SKEW_MS + 3000);
  check(
    "a paused player stays, beacon greyed",
    pausedRx.remote.count() === 1 && live !== null && beaconHex(pausedRx.car()) !== live,
  );
};

const checkRespawn = (check: Check): void => {
  const rx = new Receiver();
  rx.send(drive("r", 0, 3000, cruise(30)));
  rx.send(drive("r", 3000, 5000, () => parkedAt(300)));
  let streak = 0;
  let snapped: number | null = null;
  rx.run(SKEW_MS + 5000, () => {
    const x = rx.car()?.position.x ?? 0;
    streak += x > 95 && x < 299 ? 1 : 0;
    if (snapped === null && x >= 299) {
      snapped = rx.now;
    }
  });
  check(
    "a respawn snaps the taxi to its new spot instead of streaking it across the map",
    streak === 0 && snapped !== null && snapped < SKEW_MS + 3000 + 150,
  );
};

const checkCullAndBodies = async (check: Check): Promise<void> => {
  const rx = new Receiver();
  const at = (x: number, from: number, to: number): void => {
    rx.send(drive("c", from, to, () => parkedAt(x)));
  };
  at(100, 0, 1000);
  at(550, 1000, 2000);
  at(700, 2000, 3000);
  at(550, 3000, 4000);
  at(100, 4000, 5000);
  rx.run(SKEW_MS + 900);
  const first = rx.car();
  rx.run(SKEW_MS + 1900);
  const inBand = rx.remote.count();
  rx.run(SKEW_MS + 2900);
  const far = rx.remote.count();
  rx.run(SKEW_MS + 3900);
  const approaching = rx.remote.count();
  rx.run(SKEW_MS + 4900);
  check(
    "taxis leave and re-enter the scene through the cull band without a rebuild",
    inBand === 1 &&
      far === 0 &&
      approaching === 0 &&
      rx.remote.count() === 1 &&
      rx.car() === first &&
      rx.builds.join(",") === "waymo",
    `builds: ${rx.builds.join(",")}`,
  );

  const skins = new Receiver();
  skins.send(drive("z1", 0, 4000, () => parkedAt(10, { skin: "zoox" })));
  skins.run(SKEW_MS + 500);
  const standIn = bodyOf(skins.car())?.name;
  // The lazy GLB fetch settles.
  await settle(0);
  skins.run(SKEW_MS + 600);
  const dressed = bodyOf(skins.car())?.name;
  skins.send(drive("z2", 600, 4000, () => parkedAt(-10, { skin: "zoox" })));
  skins.send(drive("z1", 4000, 5000, () => parkedAt(10, { skin: "waymo" })));
  skins.run(SKEW_MS + 4500);
  check(
    "a peer's skin shows the default until its model lands, and each skin is built once",
    standIn === "waymo" &&
      dressed === "zoox" &&
      skins.remote.count() === 2 &&
      skins.builds.join(",") === "waymo,zoox",
    `builds: ${skins.builds.join(",")}`,
  );
  check(
    "swapping skins re-dresses the taxi from the shared bodies",
    skins.remote.group.children.some((car) => bodyOf(car)?.name === "waymo") &&
      skins.remote.group.children.some((car) => bodyOf(car)?.name === "zoox"),
  );
};

const checkInterest = (check: Check): void => {
  // A reveal waits for the next patch (50 ms), crosses the server (up to
  // ~250 ms) and is drawn 100 ms late, while two taxis close at up to a third
  // over boost speed each: the radius must clear the drop radius by twice that.
  const closing = 2 * CAR.boostSpeed * 1.35;
  const revealGap = (closing * (50 + 250 + 100)) / 1000;
  check(
    "the interest radius clears where remote taxis leave the scene, on the planar keys",
    MP_INTEREST.radius - DROP_RADIUS >= 2 * revealGap &&
      MP_INTEREST.x === "x" &&
      MP_INTEREST.y === "z",
    `${MP_INTEREST.radius} u vs ${DROP_RADIUS} u + 2 × ${revealGap.toFixed(0)} u, keys ${MP_INTEREST.x}/${MP_INTEREST.y}`,
  );

  // A peer leaves the radius, then comes back 15 u from where it left: inside
  // the respawn snap, so only a fresh start shows it there at once.
  const rx = new Receiver();
  rx.send(drive("i", 0, 2000, () => parkedAt(40, { msg: "hi", msgAt: 1 })));
  rx.run(SKEW_MS + 1500);
  const shown = rx.remote.count();
  rx.setVisible("i", false);
  rx.run(SKEW_MS + 5000);
  const away = rx.remote.count() + rx.present();
  // The reveal: the whole state first, the flag in the next message.
  const stamp = Math.round(rx.now - SKEW_MS) - 60;
  rx.patch("i", { ...parkedAt(55), msg: "while away", msgAt: 2, t: stamp });
  rx.run(rx.now + 1);
  const beforeFlag = rx.remote.count();
  rx.setVisible("i", true);
  let first: number | undefined;
  rx.run(rx.now + 1, () => {
    first ??= rx.car()?.position.x;
  });
  check(
    "a player out of interest range leaves the scene and the minimap",
    shown === 1 && away === 0 && beforeFlag === 0,
  );
  check(
    "back in range, a taxi shows at once where it is, never gliding from where it left",
    first === 55,
    `${first}`,
  );
  check(
    "a chat line said out of range is not replayed on the way back",
    rx.chats.length === 0,
    rx.chats.join(","),
  );

  const joiner = new Receiver();
  joiner.patch("far", { ...parkedAt(30), t: -50 });
  joiner.setVisible("far", false);
  joiner.run(SKEW_MS + 100);
  check(
    "a player already out of range when first seen is never drawn",
    joiner.remote.count() + joiner.present() === 0,
  );
};

/** One trailer rival as the director publishes it: no stamp, a fresh map per frame. */
const stagedRival = (x: number, say: boolean): PlayerMap => ({
  "trailer-0": {
    id: "trailer-0",
    state: { h: 0, msg: say ? "hi" : "", msgAt: say ? 1 : 0, skin: "waymo", x, y: 0, z: 0 },
  },
});

const checkStaged = (check: Check): void => {
  const rx = new Receiver();
  const xs: number[] = [];
  for (const [i, x] of [10, 11, 12.5].entries()) {
    rx.remote.sync(stagedRival(x, i === 2), "me", { staged: true });
    rx.remote.update(rx.origin, rx.now);
    xs.push(rx.car()?.position.x ?? Number.NaN);
    rx.now += FRAME_MS;
  }
  check(
    "staged trailer rivals stand exactly where the director puts them, every frame",
    xs.join(",") === "10,11,12.5" && rx.chats.join(",") === "hi",
    xs.join(","),
  );
};

export const checkRemoteCars = async (check: Check): Promise<void> => {
  checkWireFormat(check);
  checkBlend(check);
  checkSmoothMotion(check);
  checkPresence(check);
  checkRespawn(check);
  checkInterest(check);
  await checkCullAndBodies(check);
  checkStaged(check);
};
