import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { JsonObject, JsonValue } from "../json";
import { isJsonNumber } from "../json";
import { parseIntent } from "./intents";
import { Meter } from "./meter";
import type { FxRecord } from "./presentation";
import { parseFxBatch } from "./presentation";
import { INTENT_EVENT, MAX_PLAYERS, PARTY } from "./protocol";
import type { Intent } from "./protocol";
import type { BoxState, CubeSpot, MatchState, NetFrame, NetMatch } from "./snapshot";
import {
  assembleWorld,
  parseBoxes,
  parseBroken,
  parseCubes,
  parseFrame,
  parseMatch,
} from "./snapshot";

const devPartyHost = () => {
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

const MULTIPLAYER_HOST = import.meta.env.DEV ? devPartyHost() : "https://party.vibedgames.com";

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
  /** The room's host when it landed: whose route it came by. */
  host: string | null;
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
  /** Mean size of one whole frame (JSON bytes): the most a tick's frame costs, as only changed leaves travel. */
  snapshotBytes: number;
  /** Intents sent per second. */
  intentsHz: number;
}

const OFFLINE_FALLBACK_MS = 6000;
const JOIN_RESEND_MS = 3000;
const MAX_QUEUED_INTENTS = 512;
const MAX_ARRIVALS = 64;

const sharedCounter = (value: JsonValue | undefined) =>
  isJsonNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : 0;

interface Seen {
  f: JsonValue | undefined;
  m: JsonValue | undefined;
  bx: JsonValue | undefined;
  cu: JsonValue | undefined;
  br: JsonValue | undefined;
  fs: number | null;
}

const seenOf = (state: JsonObject) => {
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
  private lastJoinAt = Number.NEGATIVE_INFINITY;
  private fxSeqOut = 0;
  private readonly frames = new Meter();
  private readonly sentIntents = new Meter();
  private readonly unsubscribe: () => void;

  constructor(options: SessionOptions) {
    this.room = options.room;
    this.name = options.name;
    this.client = new MultiplayerClient({
      fallbackMs: OFFLINE_FALLBACK_MS,
      host: MULTIPLAYER_HOST,
      maxPlayers: MAX_PLAYERS,
      onEvent: (event, payload, from) => this.onEvent(event, payload, from),
      party: PARTY,
      room: options.room,
    });
    this.unsubscribe = this.client.subscribe(() => this.collect());

    if (import.meta.env.DEV) {
      window.__net = { blip: () => this.blip(), client: this.client };
    }
  }

  get playerId() {
    return this.client.connectionStatus === "connected" ? this.client.playerId : null;
  }

  get hostId() {
    return this.client.hostId;
  }

  get isHost() {
    return this.playerId !== null && this.client.isHost;
  }

  get players() {
    return this.client.players;
  }

  /** Humans in the room, including this client. */
  get playerCount() {
    return Object.keys(this.client.players).length;
  }

  /**
   * Connecting until a room first admits this client, reconnecting whenever it
   * is out of the room after that (the socket redials on its own), and offline
   * once no room admitted it within OFFLINE_FALLBACK_MS — the game then plays solo.
   */
  get status() {
    return this.client.connectionStatus;
  }

  /** The host's transport is down and the server is holding its seat. */
  get hostDropped() {
    const { hostId, players } = this.client;

    return hostId !== null && players[hostId]?.connected === false;
  }

  /** Intents can reach a live host right now. */
  get reachable() {
    return this.playerId !== null && this.client.hostId !== null && !this.hostDropped;
  }

  /** Server time now (whole ms), or null until measured — within a round trip of joining. */
  serverTime() {
    return this.client.serverClock.synced ? Math.round(this.client.serverNow()) : null;
  }

  get stats() {
    this.frames.roll();
    this.sentIntents.roll();

    return {
      intentsHz: this.sentIntents.rate,
      snapshotBytes: this.frames.meanSize,
      snapshotHz: this.frames.rate,
    };
  }

  /** Re-announce the local pick every few seconds so any host — current or future — has it. */
  announce(kit: Intent & { kind: "join" }) {
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
  sendIntent(intent: Intent) {
    if (this.playerId === null) {
      return;
    }

    if (intent.kind === "join") {
      this.client.sendEvent(INTENT_EVENT, intent);

      return;
    }

    if (this.client.isHost) {
      return;
    }

    this.client.sendToHost(INTENT_EVENT, intent);
    this.sentIntents.add();
  }

  /** Intents received since the last drain, oldest first. */
  drainIntents() {
    if (this.intents.length === 0) {
      return this.intents;
    }

    const queued = this.intents;
    this.intents = [];

    return queued;
  }

  /** The room's state as one world a promoted host can adopt, or null when absent or malformed. */
  readWorld() {
    return assembleWorld(this.client.sharedState);
  }

  /** True when the room holds shared state that is not a valid world (never overwrite blindly). */
  get hasMalformedSnapshot() {
    const { f, m } = this.client.sharedState;

    return (f !== undefined || m !== undefined) && this.readWorld() === null;
  }

  /**
   * Guest side: the room as it stands, as one arrival, and the baseline for
   * what follows — fx already in the room never replay.
   */
  baseline() {
    const state = this.client.sharedState;
    this.arrivals = [];
    this.seen = seenOf(state);

    return {
      boxes: parseBoxes(state["bx"]),
      broken: parseBroken(state["br"]),
      cubes: parseCubes(state["cu"]),
      frame: parseFrame(state["f"]),
      fx: [],
      host: this.client.hostId,
      match: parseMatch(state["m"]),
      receivedAt: performance.now(),
    };
  }

  /** Guest side: everything that arrived since the last call, oldest first. */
  takeArrivals() {
    if (this.arrivals.length === 0) {
      return this.arrivals;
    }

    const { arrivals } = this;
    this.arrivals = [];

    return arrivals;
  }

  /**
   * Host side: publish this tick's world and the fx since the last tick. The
   * client diffs it against the room's copy, so only what changed goes out.
   */
  publish(world: Publication, fx: FxRecord[]) {
    if (this.playerId === null) {
      return;
    }

    const patch: JsonObject = {
      br: world.broken,
      bx: world.boxes,
      cu: world.cubes,
      f: world.frame,
      m: world.match,
    };

    if (fx.length > 0) {
      this.fxSeqOut = Math.max(this.fxSeqOut, sharedCounter(this.client.sharedState["fs"])) + 1;
      patch["fx"] = fx;
      patch["fs"] = this.fxSeqOut;
    }

    this.seq = world.frame.s;
    this.frames.add(JSON.stringify(world.frame).length);
    this.client.updateSharedState(patch);
  }

  destroy() {
    this.unsubscribe();
    this.client.destroy();

    if (import.meta.env.DEV && window.__net?.client === this.client) {
      delete window.__net;
    }
  }

  private collect() {
    if (this.client.connectionStatus !== "connected" || this.client.isHost) {
      return;
    }

    const state = this.client.sharedState;
    const next = seenOf(state);
    const { seen } = this;
    const fresh = (key: Exclude<keyof Seen, "fs">) => next[key] !== seen[key];
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
      fx: fxFresh && seen.fs !== null ? parseFxBatch(state["fx"]) : [],
      host: this.client.hostId,
      match: fresh("m") ? parseMatch(next.m) : null,
      receivedAt: performance.now(),
    });
    this.seen = next;
  }

  private queue(arrival: Arrival) {
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
      fx: [],
      host: next.host,
      match: next.match ?? oldest.match,
      receivedAt: next.receivedAt,
    });
  }

  private onEvent(event: string, payload: JsonValue, from: string) {
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

  private blip() {
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
