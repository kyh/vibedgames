import { setTimeout as settle } from "node:timers/promises";

import * as THREE from "three";
import { FixedRate, netStats } from "@vibedgames/multiplayer";
import type { PlayerMap } from "@vibedgames/multiplayer";

import { ModelCache } from "../src/assets/loader.ts";
import { blendPose, DROP_RADIUS, readRemoteState, RemoteCars } from "../src/net/remote-cars.ts";
import { CAR, MP_INTEREST } from "../src/shared/constants.ts";
import type { JsonObject } from "../src/shared/json.ts";
import { skinById, skinModelUrl } from "../src/vehicle/car.ts";
import type { Surface } from "../src/vehicle/car.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;

const FRAME_MS = 1000 / 60;
const SKEW_MS = 7000;
const CLOCK_ERROR_MS = 6;

const noise = (i: number) => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;

  return s - Math.floor(s);
};

const flat: Surface = { heightAt: () => 0, normalInto: (out) => out.set(0, 1, 0) };

const stubCache = () => {
  const cache = new ModelCache();
  const loaded = new Set([skinModelUrl(skinById(null))]);
  cache.has = (url) => loaded.has(url);
  cache.ensure = async (url) => {
    loaded.add(url);

    await Promise.resolve();
  };

  return cache;
};

interface Packet {
  arrive: number;
  id: string;
  state: JsonObject;
}

const drive = (
  id: string,
  fromMs: number,
  toMs: number,
  pose: (ms: number) => JsonObject | null,
  latency: (i: number) => number = () => 40,
) => {
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
  (ms: number) => ({
    h: Math.PI / 2,
    skin: "waymo",
    vx: speed,
    vz: 0,
    x: x0 + (speed * ms) / 1000,
    y: 0,
    z: 0,
  });

const parkedAt = (x: number, extra: JsonObject = {}) => ({
  h: 0,
  skin: "waymo",
  vx: 0,
  vz: 0,
  x,
  y: 0,
  z: 0,
  ...extra,
});

class Receiver {
  players: PlayerMap = {};
  now = SKEW_MS;
  readonly clock = {
    now: (localNow = 0) => (this.clock.synced ? localNow - SKEW_MS + CLOCK_ERROR_MS : localNow),
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

  send(packets: readonly Packet[]) {
    this.queue = [...this.queue, ...packets].toSorted((a, b) => a.arrive - b.arrive);
  }

  patch(id: string, state: JsonObject) {
    const existing = this.players[id];
    this.players = {
      ...this.players,
      [id]: { ...existing, id, state: { ...existing?.state, ...state } },
    };
  }

  setConnected(id: string, connected: boolean) {
    const existing = this.players[id];

    if (existing) {
      this.players = { ...this.players, [id]: { ...existing, connected } };
    }
  }

  setVisible(id: string, visible: boolean) {
    const existing = this.players[id];

    if (existing) {
      this.players = { ...this.players, [id]: { ...existing, visible } };
    }
  }

  run(until: number, probe?: (now: number) => void) {
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

  car(n = 0) {
    return this.remote.group.children[n];
  }

  present() {
    let n = 0;
    this.remote.forEachPresent(() => {
      n += 1;
    }, this.now);

    return n;
  }
}

const bodyOf = (car: THREE.Object3D | undefined) =>
  car?.children.find((c) => !(c instanceof THREE.Mesh));

const beaconHex = (car: THREE.Object3D | undefined) => {
  const beacon = car?.children.find((c) => c instanceof THREE.Mesh);

  return beacon instanceof THREE.Mesh && beacon.material instanceof THREE.MeshBasicMaterial
    ? beacon.material.color.getHex()
    : null;
};

const checkWireFormat = (check: Check) => {
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

const pose = (t: number, x: number, vx: number, h = 0) => ({
  h,
  t,
  vx,
  vz: 0,
  x,
  y: 0,
  z: 0,
});

const checkBlend = (check: Check) => {
  const out = pose(0, 0, 0);
  const mid = blendPose(out, pose(0, 0, 30, 3), pose(50, 1.5, 30, -3), 0.5);
  check(
    "between updates a pose blends linearly, heading along the short arc",
    Math.abs(mid.x - 0.75) < 1e-9 && Math.abs(Math.abs(mid.h) - Math.PI) < 0.15,
    `x ${mid.x.toFixed(3)}, h ${mid.h.toFixed(3)}`,
  );
  const cruising = blendPose(out, pose(0, 0, 30), pose(50, 1.5, 30), 3).x;
  check("a late update coasts along the velocity", Math.abs(cruising - 4.5) < 1e-9, `${cruising}`);
  const crashed = blendPose(out, pose(0, 0, 30), pose(50, 1.5, 0), 3).x;
  check(
    "a taxi that stopped dead (wall hit) does not coast on its old speed",
    crashed === 1.5,
    `${crashed}`,
  );
  const slowMo = blendPose(out, pose(0, 0, 30), pose(50, 0.75, 30), 3).x;
  check(
    "a slowed owner coasts at the pace its updates show, not its chassis speed",
    Math.abs(slowMo - 2.25) < 1e-9,
    `${slowMo}`,
  );
  const bridged = blendPose(out, pose(0, 0, 30), pose(5000, 3, 30), 1.5).x;
  check("never coast on a pace measured across a silence", bridged === 3, `${bridged}`);
};

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

const checkSmoothMotion = (check: Check) => {
  const typical = cruiseOver(40, 100);
  check(
    "a remote taxi on a jittery link moves at its true speed every frame",
    typical.minStep > 0.8 && typical.maxStep < 1.2,
    `per-frame speed ${(typical.minStep * 100).toFixed(0)}–${(typical.maxStep * 100).toFixed(0)}% of true`,
  );
  check("a remote taxi cruising straight never rubber-bands backwards", typical.backwards === 0);
  check(
    "a remote taxi trails its owner by its fastest relay plus what its link's lateness needs",
    typical.lagMs > 40 + 100 && typical.lagMs < 40 + 50 + 100 + FRAME_MS,
    `${typical.lagMs.toFixed(0)} ms behind`,
  );
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

const checkPresence = (check: Check) => {
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

  const joiner = new Receiver();
  joiner.patch("live", { ...parkedAt(5), t: -80 });
  joiner.run(SKEW_MS);
  check(
    "a current pose found on joining shows at once, without waiting for the next",
    joiner.remote.count() === 1,
  );

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

const checkRespawn = (check: Check) => {
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

const checkOwnerDrop = (check: Check) => {
  const rx = new Receiver();
  rx.send(drive("o", 0, 2000, () => parkedAt(60)));
  rx.send(drive("o", 3000, 5000, () => parkedAt(75)));
  rx.run(SKEW_MS + 2100);
  rx.setConnected("o", false);
  rx.run(rx.now + 1);
  const dropped = rx.remote.count();
  rx.run(SKEW_MS + 3000);
  rx.setConnected("o", true);
  rx.run(rx.now + 1);
  const unheard = rx.remote.count();
  let first: number | undefined;
  rx.run(SKEW_MS + 3300, () => {
    first ??= rx.car()?.position.x;
  });
  check(
    "a dropped connection hides the taxi at once; back, it shows with its first pose since, where it is",
    dropped === 0 && unheard === 0 && first === 75,
    `${first}`,
  );
};

const acrossDrop = (whose: "ours" | "owner") => {
  const rx = new Receiver();
  const speed = 30;
  const before = drive("d", 0, 4000, cruise(speed), (i) => 40 + 20 * noise(i));
  const after = drive("d", 5000, 9000, cruise(speed), (i) => 440 + 20 * noise(i));
  const lost = before.at(-1)?.arrive ?? 0;
  const back = after[0]?.arrive ?? 0;
  rx.send([...before, ...after]);
  rx.run(lost + 100);

  if (whose === "owner") {
    rx.setConnected("d", false);
  }

  rx.run(back - 1);

  if (whose === "ours") {
    rx.remote.relearn();
  } else {
    rx.setConnected("d", true);
  }

  const from = back + 250;
  const until = SKEW_MS + 8600;
  rx.run(from);
  const counted = netStats();
  let prev: number | null = null;
  let minStep = Infinity;
  let maxStep = 0;
  rx.run(until, () => {
    const x = rx.car()?.position.x ?? Number.NaN;

    if (prev !== null) {
      const step = (x - prev) / ((speed * FRAME_MS) / 1000);
      minStep = Math.min(minStep, step);
      maxStep = Math.max(maxStep, step);
    }

    prev = x;
  });
  const stats = netStats();

  return {
    frames: stats.frames - counted.frames,
    maxStep,
    minStep,
    starved: stats.starved - counted.starved,
  };
};

const checkRouteChange = (check: Check) => {
  for (const whose of ["ours", "owner"] as const) {
    const back = acrossDrop(whose);
    check(
      whose === "ours"
        ? "back from our own drop onto a slower route, a taxi runs smoothly within a quarter second, never past its newest update"
        : "an owner back from its drop by a slower route runs smoothly within a quarter second, never past its newest update",
      back.frames > 0 && back.starved === 0 && back.minStep > 0.8 && back.maxStep < 1.2,
      `${back.starved} of ${back.frames} frames past the newest, per-frame speed ${(back.minStep * 100).toFixed(0)}–${(back.maxStep * 100).toFixed(0)}% of true`,
    );
  }
};

const checkCullAndBodies = async (check: Check) => {
  const rx = new Receiver();

  const at = (x: number, from: number, to: number) => {
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

const checkInterest = (check: Check) => {
  const closing = 2 * CAR.boostSpeed * 1.35;
  const revealGap = (closing * (50 + 250 + 100)) / 1000;
  check(
    "the interest radius clears where remote taxis leave the scene, on the planar keys",
    MP_INTEREST.radius - DROP_RADIUS >= 2 * revealGap &&
      MP_INTEREST.x === "x" &&
      MP_INTEREST.y === "z",
    `${MP_INTEREST.radius} u vs ${DROP_RADIUS} u + 2 × ${revealGap.toFixed(0)} u, keys ${MP_INTEREST.x}/${MP_INTEREST.y}`,
  );

  const rx = new Receiver();
  rx.send(drive("i", 0, 2000, () => parkedAt(40, { msg: "hi", msgAt: 1 })));
  rx.run(SKEW_MS + 1500);
  const shown = rx.remote.count();
  rx.setVisible("i", false);
  rx.run(SKEW_MS + 5000);
  const away = rx.remote.count() + rx.present();
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

const stagedRival = (x: number, say: boolean) => ({
  "trailer-0": {
    id: "trailer-0",
    state: { h: 0, msg: say ? "hi" : "", msgAt: say ? 1 : 0, skin: "waymo", x, y: 0, z: 0 },
  },
});

const checkStaged = (check: Check) => {
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

export const checkRemoteCars = async (check: Check) => {
  checkWireFormat(check);
  checkBlend(check);
  checkSmoothMotion(check);
  checkPresence(check);
  checkRespawn(check);
  checkOwnerDrop(check);
  checkRouteChange(check);
  checkInterest(check);
  await checkCullAndBodies(check);
  checkStaged(check);
};
