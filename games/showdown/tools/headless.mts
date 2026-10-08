// Scene-free stand-ins for the smoke tests: a Game that real brawlers and the
// host's intent path can run against, an open courtyard, and the JSON hop
// every snapshot and intent takes over the socket.
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

export interface Wire {
  send: (now: number, data: string) => void;
  take: (now: number) => string[];
  readonly delays: number[];
}

/** One direction of a WebSocket: latency plus jitter, and never out of order. */
export const wire = (seed: number, latency: number, jitter: number): Wire => {
  const rng = seededRandom(seed);
  const queue: { at: number; data: string }[] = [];
  const delays: number[] = [];
  let last = 0;
  return {
    delays,
    send: (now, data) => {
      const at = Math.max(last, now + latency + (rng() * 2 - 1) * jitter);
      last = at;
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
