// The transport adapter: one MultiplayerClient, intent routing, the snapshot
// and fx channels, connection status and the offline-fallback deadline. No
// three.js and no game rules live here — the host and guest modules turn what
// this hands them into sim state.
//
// Intents go to the host alone (`join` excepted: every client keeps the picks a
// future host will need). The host publishes a frame every tick and the slower
// keys only when they change. A guest collects each frame the moment its
// message lands, stamped with that arrival time: interpolation needs to know
// when every frame arrived, and reading the merged state once per render frame
// would lose frames that land together.
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { PlayerMap } from "@vibedgames/multiplayer";
import type { JsonObject, JsonValue } from "../json";
import { isJsonNumber } from "../json";
import { parseIntent } from "./intents";
import { Meter } from "./meter";
import type { FxRecord } from "./presentation";
import { parseFxBatch } from "./presentation";
import { INTENT_EVENT, MAX_PLAYERS, PARTY } from "./protocol";
import type { Intent } from "./protocol";
import type { BoxState, CubeSpot, MatchState, NetFrame, NetMatch, WorldState } from "./snapshot";
import {
  assembleWorld,
  parseBoxes,
  parseBroken,
  parseCubes,
  parseFrame,
  parseMatch,
} from "./snapshot";

/**
 * Dev-only override for the party host: `?party=8788` (port) or
 * `?party=http://host:port`, so QA can point at a party server on a
 * non-default port without rebuilding. Ignored in production builds.
 */
const devPartyHost = (): string => {
  const fallback = "http://localhost:8787";
  if (!("location" in globalThis)) {
    return fallback;
  }
  const p = new URLSearchParams(location.search).get("party");
  if (!p) {
    return fallback;
  }
  return /^https?:\/\//u.test(p) ? p : `http://localhost:${p}`;
};

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? devPartyHost()
  : "https://vibedgames-party.kyh.workers.dev";

export type SessionStatus = "connecting" | "connected" | "reconnecting";

export interface SessionOptions {
  name: string;
  room: string;
}

/** A guest's intent as received by the host, tagged with its sender. */
export interface RemoteIntent {
  from: string;
  intent: Intent;
}

/** What one message from the host changed, parsed, with the moment it landed. */
export interface Arrival {
  receivedAt: number;
  frame: NetFrame | null;
  match: MatchState | null;
  boxes: BoxState[] | null;
  cubes: CubeSpot[] | null;
  broken: number[] | null;
  fx: FxRecord[];
}

/** The host's world for one tick, in wire form. */
export interface Publication {
  frame: NetFrame;
  match: NetMatch;
  boxes: number[];
  cubes: number[];
  broken: number[];
}

/** Traffic over the last second, for diagnostics. */
export interface NetStats {
  /** Frames sent (host) or received (guest) per second. */
  snapshotHz: number;
  /** Mean size of one frame on the wire (JSON bytes). */
  snapshotBytes: number;
  /** Intents sent per second. */
  intentsHz: number;
}

/** Seconds from the first update tick before an unreachable server means "play vs bots". */
const OFFLINE_FALLBACK_S = 6;
/** How often a client re-announces its pick, so a newly promoted host learns it. */
const JOIN_RESEND_MS = 3000;
/** Queued remote intents beyond this are dropped: a flood must not stall a frame. */
const MAX_QUEUED_INTENTS = 512;
/** Arrivals waiting for a frame beyond this are folded together (a backgrounded tab). */
const MAX_ARRIVALS = 64;
/** Keys besides the frame, published only when they change. */
const SLOW_KEYS = ["m", "bx", "cu", "br"] as const;

type SlowKey = (typeof SLOW_KEYS)[number];

const sharedCounter = (value: JsonValue | undefined): number =>
  isJsonNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** The shared-state values a guest last folded in, compared by identity: every patch replaces its keys. */
interface Seen {
  f: JsonValue | undefined;
  m: JsonValue | undefined;
  bx: JsonValue | undefined;
  cu: JsonValue | undefined;
  br: JsonValue | undefined;
  fs: number | null;
}

const seenOf = (state: JsonObject): Seen => {
  const { br, bx, cu, f, fs, m } = state;
  return { br, bx, cu, f, fs: isJsonNumber(fs) ? fs : null, m };
};

declare global {
  interface Window {
    __net?: { blip: () => void; client: MultiplayerClient };
  }
}

const isMethod = (v: unknown): v is (...args: number[]) => void => typeof v === "function";

export class Session {
  readonly client: MultiplayerClient;
  readonly room: string;
  readonly name: string;
  /** Sequence of the last frame sent (host) or received (guest). */
  seq = 0;
  /** Once true, a later drop is transient: reconnect, never fall back to bots. */
  private everConnected = false;
  private uptime = 0;
  private intents: RemoteIntent[] = [];
  private arrivals: Arrival[] = [];
  private seen: Seen = {
    br: undefined,
    bx: undefined,
    cu: undefined,
    f: undefined,
    fs: null,
    m: undefined,
  };
  private readonly published = new Map<SlowKey, string>();
  private lastJoinAt = Number.NEGATIVE_INFINITY;
  private fxSeqOut = 0;
  private readonly frames = new Meter();
  private readonly sentIntents = new Meter();
  private readonly unsubscribe: () => void;
  /** A closed tab must vacate its seat now, or the room waits out the grace window on it. */
  private readonly onPageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) {
      this.destroy();
    }
  };

  constructor(options: SessionOptions) {
    this.room = options.room;
    this.name = options.name;
    this.client = new MultiplayerClient({
      host: MULTIPLAYER_HOST,
      maxPlayers: MAX_PLAYERS,
      onEvent: (event, payload, from) => this.onEvent(event, payload, from),
      party: PARTY,
      room: options.room,
    });
    this.unsubscribe = this.client.subscribe(() => this.collect());
    window.addEventListener("pagehide", this.onPageHide);
    if (import.meta.env.DEV) {
      window.__net = { blip: () => this.blip(), client: this.client };
    }
  }

  get playerId(): string | null {
    return this.client.connectionStatus === "connected" ? this.client.playerId : null;
  }

  get hostId(): string | null {
    return this.client.hostId;
  }

  get isHost(): boolean {
    return this.playerId !== null && this.client.isHost;
  }

  get players(): PlayerMap {
    return this.client.players;
  }

  /** Humans in the room, including this client. */
  get playerCount(): number {
    return Object.keys(this.client.players).length;
  }

  get status(): SessionStatus {
    if (this.client.connectionStatus === "connected") {
      return "connected";
    }
    return this.everConnected ? "reconnecting" : "connecting";
  }

  /** The host's transport is down and the server is holding its seat. */
  get hostDropped(): boolean {
    const { hostId, players } = this.client;
    return hostId !== null && players[hostId]?.connected === false;
  }

  /** Intents can reach a live host right now. */
  get reachable(): boolean {
    return this.playerId !== null && this.client.hostId !== null && !this.hostDropped;
  }

  get stats(): NetStats {
    this.frames.roll();
    this.sentIntents.roll();
    return {
      intentsHz: this.sentIntents.rate,
      snapshotBytes: this.frames.meanSize,
      snapshotHz: this.frames.rate,
    };
  }

  /** Advance the connect deadline; returns true the moment the offline fallback should fire. */
  update(dt: number): boolean {
    if (this.client.connectionStatus === "connected") {
      this.everConnected = true;
      return false;
    }
    if (this.everConnected) {
      return false;
    }
    this.uptime += dt;
    return this.uptime >= OFFLINE_FALLBACK_S;
  }

  /** Re-announce the local pick every few seconds so any host — current or future — has it. */
  announce(kit: Intent & { kind: "join" }): void {
    if (!this.playerId) {
      return;
    }
    const now = performance.now();
    if (now - this.lastJoinAt < JOIN_RESEND_MS) {
      return;
    }
    this.lastJoinAt = now;
    this.sendIntent(kit);
  }

  /** `join` goes to every client; everything else to the host alone. */
  sendIntent(intent: Intent): void {
    // A closed transport queues sends without bound; the join re-announce covers the gap.
    if (this.playerId === null) {
      return;
    }
    if (intent.kind === "join") {
      this.client.sendEvent(INTENT_EVENT, intent);
      return;
    }
    const host = this.client.hostId;
    if (host === null || host === this.playerId) {
      return;
    }
    this.client.sendEvent(INTENT_EVENT, intent, { to: host });
    this.sentIntents.add();
  }

  /** Intents received since the last drain, oldest first. */
  drainIntents(): RemoteIntent[] {
    if (this.intents.length === 0) {
      return this.intents;
    }
    const queued = this.intents;
    this.intents = [];
    return queued;
  }

  /** The room's state as one world a promoted host can adopt, or null when absent or malformed. */
  readWorld(): WorldState | null {
    return assembleWorld(this.client.sharedState);
  }

  /** True when the room holds shared state that is not a valid world (never overwrite blindly). */
  get hasMalformedSnapshot(): boolean {
    const { f, m } = this.client.sharedState;
    return (f !== undefined || m !== undefined) && this.readWorld() === null;
  }

  /**
   * Guest side: the room as it stands, as one arrival, and the baseline for
   * what follows — fx already in the room never replay.
   */
  baseline(): Arrival {
    const state = this.client.sharedState;
    this.arrivals = [];
    this.seen = seenOf(state);
    return {
      boxes: parseBoxes(state["bx"]),
      broken: parseBroken(state["br"]),
      cubes: parseCubes(state["cu"]),
      frame: parseFrame(state["f"]),
      fx: [],
      match: parseMatch(state["m"]),
      receivedAt: performance.now(),
    };
  }

  /** Guest side: everything that arrived since the last call, oldest first. */
  takeArrivals(): Arrival[] {
    if (this.arrivals.length === 0) {
      return this.arrivals;
    }
    const { arrivals } = this;
    this.arrivals = [];
    return arrivals;
  }

  /** Host side: publish this tick's frame, the slow keys that changed, and the fx since the last tick. */
  publish(world: Publication, fx: FxRecord[], everything = false): void {
    if (this.playerId === null) {
      return;
    }
    const patch: JsonObject = { f: world.frame };
    const slow: Record<SlowKey, JsonValue> = {
      br: world.broken,
      bx: world.boxes,
      cu: world.cubes,
      m: world.match,
    };
    for (const key of SLOW_KEYS) {
      const encoded = JSON.stringify(slow[key]);
      if (everything || this.published.get(key) !== encoded) {
        this.published.set(key, encoded);
        patch[key] = slow[key];
      }
    }
    if (fx.length > 0) {
      this.fxSeqOut = Math.max(this.fxSeqOut, sharedCounter(this.client.sharedState["fs"])) + 1;
      patch["fx"] = fx;
      patch["fs"] = this.fxSeqOut;
    }
    this.seq = world.frame.s;
    this.frames.add(JSON.stringify(world.frame).length);
    this.client.updateSharedState(patch);
  }

  destroy(): void {
    window.removeEventListener("pagehide", this.onPageHide);
    this.unsubscribe();
    this.client.destroy();
    if (import.meta.env.DEV && window.__net?.client === this.client) {
      delete window.__net;
    }
  }

  /** Runs on every server message, so no frame is lost between two render frames. */
  private collect(): void {
    if (this.client.connectionStatus !== "connected" || this.client.isHost) {
      return;
    }
    const state = this.client.sharedState;
    const next = seenOf(state);
    const { seen } = this;
    const fresh = (key: Exclude<keyof Seen, "fs">): boolean => next[key] !== seen[key];
    const fxFresh = next.fs !== seen.fs;
    if (!fresh("f") && !fresh("m") && !fresh("bx") && !fresh("cu") && !fresh("br") && !fxFresh) {
      return;
    }
    const frame = fresh("f") ? parseFrame(next.f) : null;
    if (frame) {
      this.frames.add(JSON.stringify(next.f).length);
    }
    this.queue({
      boxes: fresh("bx") ? parseBoxes(next.bx) : null,
      broken: fresh("br") ? parseBroken(next.br) : null,
      cubes: fresh("cu") ? parseCubes(next.cu) : null,
      frame,
      // The first batch ever seen is the room's history, not news.
      fx: fxFresh && seen.fs !== null ? parseFxBatch(state["fx"]) : [],
      match: fresh("m") ? parseMatch(next.m) : null,
      receivedAt: performance.now(),
    });
    this.seen = next;
  }

  /** A tab that stops rendering keeps receiving: fold the backlog instead of growing it. */
  private queue(arrival: Arrival): void {
    this.arrivals.push(arrival);
    if (this.arrivals.length <= MAX_ARRIVALS) {
      return;
    }
    const [oldest, next] = this.arrivals;
    if (!oldest || !next) {
      return;
    }
    this.arrivals.splice(0, 2, {
      boxes: next.boxes ?? oldest.boxes,
      broken: next.broken ?? oldest.broken,
      cubes: next.cubes ?? oldest.cubes,
      frame: next.frame ?? oldest.frame,
      // Effects that old are not worth replaying in a burst.
      fx: [],
      match: next.match ?? oldest.match,
      receivedAt: next.receivedAt,
    });
  }

  private onEvent(event: string, payload: JsonValue, from: string): void {
    if (event !== INTENT_EVENT) {
      return;
    }
    const sender = this.client.players[from];
    if (!sender || sender.connected === false) {
      return;
    }
    const intent = parseIntent(payload);
    if (!intent || this.intents.length >= MAX_QUEUED_INTENTS) {
      return;
    }
    this.intents.push({ from, intent });
  }

  /** Test hook: drop the transport without leaving, as a network blip would. */
  private blip(): void {
    const socket: unknown = Object.entries(this.client).find(([key]) => key === "socket")?.[1];
    if (
      !(socket instanceof Object) ||
      !("close" in socket) ||
      !isMethod(socket.close) ||
      !("reconnect" in socket) ||
      !isMethod(socket.reconnect)
    ) {
      return;
    }
    socket.close(4000);
    socket.reconnect();
  }
}
