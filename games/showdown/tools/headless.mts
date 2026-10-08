// Scene-free stand-ins for the smoke tests: a Game that real brawlers and the
// host's intent path can run against, an open courtyard, the JSON hop every
// snapshot and intent takes over the socket, the relay it takes (each client's
// own link to the server, so host and guest are two hops apart), and each
// client's own reading of the room's server clock.
import { ServerClock } from "@vibedgames/multiplayer";
import { BRAWLERS, DIFFICULTIES } from "../src/config.ts";
import type { BrawlerId } from "../src/config.ts";
import { Brawler } from "../src/entities/brawler.ts";
import type { BrawlerOptions } from "../src/entities/brawler.ts";
import type { Game } from "../src/game.ts";
import type { JsonValue } from "../src/json.ts";
import { parseJson } from "../src/json.ts";
import type { RemoteIntent } from "../src/net/session.ts";
import { seededRandom } from "../src/utils.ts";
import { terrainHeight } from "../src/world/terrain.ts";

const ignore = (): number => 0;

/** Every presentation sink is a no-op: nothing a test checks reads an effect back. */
const silent = new Proxy({}, { get: () => ignore });

/** A flat, open courtyard: z = 0 is level ground and nothing blocks. */
export const openWorld = {
  heightAt: terrainHeight,
  isBushAt: () => false,
  nearestOpen: (x: number, z: number) => ({ x, z }),
  resolveCircle: () => null,
};

/** The slice of `Game` a brawler and the host's intent path touch, with no scene behind it. */
export const stubGame = (mode: "guest" | "host", inbox: RemoteIntent[] = []) => {
  const brawlers: Brawler[] = [];
  return {
    asActor: (_actor: Brawler, present: () => void) => present(),
    audio: silent,
    brawlers,
    combat: silent,
    countdownT: 0,
    difficulty: DIFFICULTIES.normal,
    effects: silent,
    elapsed: 0,
    generation: 1,
    hud: silent,
    matchTime: 30,
    mercy: { damageScale: 1 },
    mode,
    picks: new Map(),
    rng: seededRandom(5),
    scene: { add: () => null, remove: () => null },
    session: { drainIntents: () => inbox.splice(0), playerId: mode === "host" ? "host" : "guest" },
    state: "playing",
    world: openWorld,
  };
};

export type StubGame = ReturnType<typeof stubGame>;

/** Every member a body, the host's intent path or the wire encoder reads. */
const PLAYED = ["asActor", "brawlers", "elapsed", "mode", "picks", "rng", "session", "world"];

const playsGame = (stub: StubGame): stub is StubGame & Game => PLAYED.every((key) => key in stub);

/** Hand the stub to code typed against `Game`; it carries everything that code reads. */
export const asGame = (stub: StubGame): Game => {
  if (!playsGame(stub)) {
    throw new Error("the stub game is missing a member the sim reads");
  }
  return stub;
};

/** A real brawler on a stub game, added to its roster. */
export const body = (
  stub: StubGame,
  options: BrawlerOptions,
  kit: BrawlerId = "titan",
): Brawler => {
  const b = new Brawler(asGame(stub), BRAWLERS[kit], options);
  stub.brawlers.push(b);
  return b;
};

/** A value as the far side of the socket sees it: serialized, then parsed. */
export const overTheWire = (value: JsonValue): JsonValue => parseJson(JSON.stringify(value));

/** One direction of one client's socket to the server: when a message sent at `now` lands. */
export type Hop = (now: number) => number;

/** A hop of `latency ± jitter` that never reorders what crosses it. */
export const hop = (seed: number, latency: number, jitter: number): Hop => {
  const rng = seededRandom(seed);
  let last = 0;
  return (now) => {
    last = Math.max(last, now + latency + (rng() * 2 - 1) * jitter);
    return last;
  };
};

export interface Wire {
  send: (now: number, data: string) => void;
  take: (now: number) => string[];
  /** How long each message took, end to end. */
  readonly delays: number[];
}

/**
 * Messages across `hops` in turn. Clients never talk directly: a host's frame
 * crosses the host's link up to the server, then the guest's link down.
 */
export const wire = (...hops: Hop[]): Wire => {
  const queue: { at: number; data: string }[] = [];
  const delays: number[] = [];
  return {
    delays,
    send: (now, data) => {
      let at = now;
      for (const leg of hops) {
        at = leg(at);
      }
      delays.push(at - now);
      queue.push({ at, data });
    },
    take: (now) => {
      const out: string[] = [];
      while (queue.length > 0 && (queue[0]?.at ?? Number.POSITIVE_INFINITY) <= now) {
        out.push(queue.shift()?.data ?? "");
      }
      return out;
    },
  };
};

/** Server time is the tests' shared wall clock plus this: an epoch, like no client's local clock. */
export const SERVER_EPOCH = 1_790_000_000_000;

/** One client's clocks, as functions of the tests' shared wall time. */
export interface PeerClock {
  /** This client's performance.now(). */
  local: (wall: number) => number;
  /** The room's server clock as this client measured it (`client.serverClock`). */
  server: ServerClock;
  /** Server time by that measurement, in whole ms as frames are stamped. */
  serverAt: (wall: number) => number;
}

/**
 * A client whose page loaded at wall time `loadedAt`, measuring server time as
 * the SDK does: probes over a link of `latency ± jitter` each way, the fastest
 * round trip defining the offset. Its reading is off by half that trip's
 * asymmetry, and differs from every other client's by a few ms.
 */
export const peerClock = (
  seed: number,
  loadedAt: number,
  latency: number,
  jitter: number,
): PeerClock => {
  const rng = seededRandom(seed);
  const server = new ServerClock();
  const local = (wall: number): number => wall - loadedAt;
  for (let probe = 0; probe < 8; probe += 1) {
    const sent = probe * 250;
    const up = latency + (rng() * 2 - 1) * jitter;
    const down = latency + (rng() * 2 - 1) * jitter;
    server.sample(local(sent), SERVER_EPOCH + sent + up, local(sent + up + down));
  }
  return { local, server, serverAt: (wall) => Math.round(server.now(local(wall))) };
};

/** One client as the network sees it: its link to the server, both ways, and its reading of the server clock. */
export interface Peer {
  clock: PeerClock;
  /** Server to this client. */
  down: Hop;
  /** This client to the server. */
  up: Hop;
}

/** A client whose page loaded at wall time `loadedAt`, on a link of `latency ± jitter` each way. */
export const peer = (seed: number, loadedAt: number, latency: number, jitter: number): Peer => ({
  clock: peerClock(seed, loadedAt, latency, jitter),
  down: hop(seed + 1, latency, jitter),
  up: hop(seed + 2, latency, jitter),
});
