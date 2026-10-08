// Remote-car netcode, headless: real RemoteCars and Interpolator, fed by
// simulated drivers (a 60 fps loop sending on a 20 Hz FixedRate, each update
// stamped with the driver's own clock and delivered in order after a jittered
// latency) and read back at 60 fps — the way a peer's browser sees them.
import { setTimeout as settle } from "node:timers/promises";

import * as THREE from "three";
import { FixedRate } from "@vibedgames/multiplayer";
import type { PlayerMap } from "@vibedgames/multiplayer";

import { ModelCache } from "../src/assets/loader.ts";
import { blendPose, readRemoteState, RemoteCars } from "../src/net/remote-cars.ts";
import type { RemotePose } from "../src/net/remote-cars.ts";
import type { JsonObject } from "../src/shared/json.ts";
import { skinById, skinModelUrl } from "../src/vehicle/car.ts";
import type { Surface } from "../src/vehicle/car.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;

const FRAME_MS = 1000 / 60;
/** Receiver clock minus every sender's: two machines share no epoch. */
const SKEW_MS = 7000;

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
 * One remote driver from sender time `fromMs` to `toMs`: `pose` is its car
 * (null while its tab is hidden and nothing goes out), stamped with the
 * sender's clock and delivered in order after `latency(i)` ms.
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
  readonly builds: string[] = [];
  readonly chats: string[] = [];
  readonly origin = new THREE.Vector3();
  readonly remote = new RemoteCars(
    stubCache(),
    flat,
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
  const parsed = readRemoteState(
    { h: 1, p: 1, skin: "zoox", t: 1234, vx: 3, vz: -4, x: 10, y: 2, z: -5 },
    99,
  );
  check(
    "remote state reads the stamp, velocity, pause flag and skin",
    parsed?.t === 1234 &&
      parsed.stamped &&
      parsed.vx === 3 &&
      parsed.vz === -4 &&
      parsed.paused &&
      parsed.skin === "zoox",
  );
  const legacy = readRemoteState({ h: 0, skin: "nonsense", x: 1, z: 2 }, 99);
  check(
    "an unstamped state is timed by its arrival and an unknown skin is the default",
    legacy?.t === 99 && !legacy.stamped && legacy.skin === "waymo" && legacy.vx === 0,
  );
  check(
    "a state without a finite transform is no car",
    readRemoteState({ h: 0, x: 1 }, 0) === null &&
      readRemoteState({ h: 0, x: "1", z: 2 }, 0) === null &&
      readRemoteState(null, 0) === null,
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

const checkSmoothMotion = (check: Check): void => {
  // 30 u/s with 40–140 ms of latency jitter: wider than the 50 ms interval,
  // so the buffer runs dry now and then and late updates are coasted over.
  const rx = new Receiver();
  const speed = 30;
  rx.send(drive("a", 0, 9000, cruise(speed), (i) => 40 + 100 * noise(i)));
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
  check(
    "a remote taxi on a jittery link moves at its true speed every frame",
    minStep > 0.8 && maxStep < 1.2,
    `per-frame speed ${(minStep * 100).toFixed(0)}–${(maxStep * 100).toFixed(0)}% of true`,
  );
  check("a remote taxi cruising straight never rubber-bands backwards", backwards === 0);
  check(
    "a remote taxi trails its owner by the render delay plus the fastest path",
    lagMs > 110 && lagMs < 200,
    `${lagMs.toFixed(0)} ms behind`,
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

  // Joining a room that still holds a hidden tab's last pose.
  const late = new Receiver();
  late.patch("old", { ...parkedAt(5), t: 123 });
  late.run(SKEW_MS + 3000);
  const ghost = late.remote.count() + late.present();
  late.send([{ arrive: late.now, id: "old", state: { ...parkedAt(5), t: 130_000 } }]);
  late.run(late.now + 1);
  check(
    "a stale pose found on joining shows only once its owner speaks",
    ghost === 0 && late.remote.count() === 1,
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
    rx.remote.sync(stagedRival(x, i === 2), "me", { now: rx.now, staged: true });
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
  await checkCullAndBodies(check);
  checkStaged(check);
};
