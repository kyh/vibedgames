// The transport adapter: one MultiplayerClient, intent routing, the snapshot
// and fx channels, connection status and the offline-fallback deadline. No
// three.js and no game rules live here — the host and guest modules turn what
// this hands them into sim state.
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { PlayerMap } from "@vibedgames/multiplayer";
import { isBrawlerId } from "../config";
import type { JsonValue } from "../json";
import { isJsonNumber, isJsonObject, isJsonString } from "../json";
import { parseInputState, shouldSendInput } from "./input-intent";
import type { InputState } from "./input-intent";
import type { FxRecord } from "./presentation";
import { parseFxBatch } from "./presentation";
import { INTENT_EVENT, MAX_NAME_LENGTH, MAX_PLAYERS, MULTIPLAYER_HOST, PARTY } from "./protocol";
import type { Intent } from "./protocol";
import type { Snapshot } from "./snapshot";
import { isSnapshot } from "./snapshot";

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

/** Seconds from the first update tick before an unreachable server means "play vs bots". */
const OFFLINE_FALLBACK_S = 6;
/** How often a client re-announces its pick, so a newly promoted host learns it. */
const JOIN_RESEND_MS = 3000;
/** Queued remote intents beyond this are dropped: a flood must not stall a frame. */
const MAX_QUEUED_INTENTS = 512;
/** World half-extent plus margin — a target point outside this is nonsense. */
const MAX_COORD = 40;

const clamp1 = (n: number): number => Math.max(-1, Math.min(1, n));
const clampCoord = (n: number): number => Math.max(-MAX_COORD, Math.min(MAX_COORD, n));
const num = (v: JsonValue | undefined): number => (isJsonNumber(v) ? v : 0);

const sharedCounter = (value: JsonValue | undefined): number =>
  isJsonNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Parse a wire intent field by field; a malformed or spoofed shape yields null. */
const parseIntent = (payload: JsonValue): Intent | null => {
  if (!isJsonObject(payload)) {
    return null;
  }
  switch (payload["kind"]) {
    case "join": {
      const { kit, name } = payload;
      if (!isJsonString(kit) || !isBrawlerId(kit) || !isJsonString(name)) {
        return null;
      }
      return { kind: "join", kit, name: name.slice(0, MAX_NAME_LENGTH) };
    }
    case "input": {
      return { ...parseInputState(payload), kind: "input" };
    }
    case "evade": {
      const { dx, dz, seq } = payload;
      if (
        !isJsonNumber(dx) ||
        !isJsonNumber(dz) ||
        !isJsonNumber(seq) ||
        !Number.isSafeInteger(seq) ||
        seq < 1
      ) {
        return null;
      }
      return { dx: clamp1(dx), dz: clamp1(dz), kind: "evade", seq };
    }
    case "attack":
    case "super": {
      return {
        dx: clamp1(num(payload["dx"])),
        dz: clamp1(num(payload["dz"])),
        kind: payload["kind"],
        x: clampCoord(num(payload["x"])),
        z: clampCoord(num(payload["z"])),
      };
    }
    case "again": {
      return { kind: "again" };
    }
    default: {
      return null;
    }
  }
};

declare global {
  interface Window {
    __net?: { blip: () => void; client: MultiplayerClient };
  }
}

// oxlint-disable-next-line anti-slop/no-runtime-typeof -- the client's private socket publishes no contract; the dev blip hook only needs two callables
const isMethod = (v: unknown): v is (...args: number[]) => void => typeof v === "function";

export class Session {
  readonly client: MultiplayerClient;
  readonly room: string;
  readonly name: string;
  /** Sequence of the last snapshot sent (host) or applied (guest). */
  seq = 0;
  /** Once true, a later drop is transient: reconnect, never fall back to bots. */
  private everConnected = false;
  private uptime = 0;
  private snapSource: JsonValue | undefined;
  private snapParsed: Snapshot | null = null;
  private intents: RemoteIntent[] = [];
  private lastJoinAt = Number.NEGATIVE_INFINITY;
  private lastInput: InputState = { look: null, mx: 0, mz: 0 };
  private inputSentAt = Number.NEGATIVE_INFINITY;
  private fxSeqOut = 0;
  private lastFxSeq: number | null = null;
  private pendingFx: FxRecord[] = [];
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
    this.unsubscribe = this.client.subscribe(() => this.collectFx());
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

  sendIntent(intent: Intent): void {
    // A closed transport queues sends without bound; the join re-announce covers the gap.
    if (this.playerId === null) {
      return;
    }
    this.client.sendEvent(INTENT_EVENT, intent);
  }

  /** Movement and passive facing share one coalesced input message. */
  sendInput(mx: number, mz: number, look: number | null = null): void {
    if (this.playerId === null) {
      return;
    }
    const now = performance.now();
    const next = { look, mx, mz };
    if (!shouldSendInput(this.lastInput, next, now - this.inputSentAt)) {
      return;
    }
    this.inputSentAt = now;
    this.lastInput = next;
    this.client.sendEvent(INTENT_EVENT, { ...next, kind: "input" }, { coalesce: true });
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

  /** The room's current snapshot, or null when absent or malformed. */
  readSnapshot(): Snapshot | null {
    return this.parsedSnapshot();
  }

  /** True when the room holds shared state that is not a valid snapshot (never overwrite blindly). */
  get hasMalformedSnapshot(): boolean {
    const { snap } = this.client.sharedState;
    return snap !== undefined && snap !== null && this.parsedSnapshot() === null;
  }

  /** Forget the fx watermark: the next batch observed becomes the baseline and nothing replays. */
  resetFxBaseline(): void {
    this.lastFxSeq = null;
    this.pendingFx = [];
  }

  /** Guest side: fx rows that arrived since the last call. */
  takeFx(): FxRecord[] {
    this.collectFx();
    if (this.pendingFx.length === 0) {
      return this.pendingFx;
    }
    const rows = this.pendingFx;
    this.pendingFx = [];
    return rows;
  }

  /** Host side: publish the snapshot with the fx recorded since the last broadcast. */
  broadcast(snapshot: Snapshot, fx: FxRecord[]): void {
    if (this.playerId === null) {
      return;
    }
    this.fxSeqOut = Math.max(this.fxSeqOut, sharedCounter(this.client.sharedState["fxSeq"])) + 1;
    // Our own rendered batch must never echo back after a reconnect.
    this.lastFxSeq = this.fxSeqOut;
    this.seq = snapshot.seq;
    this.client.updateSharedState({ fx, fxSeq: this.fxSeqOut, snap: snapshot });
  }

  destroy(): void {
    window.removeEventListener("pagehide", this.onPageHide);
    this.unsubscribe();
    this.client.destroy();
    if (import.meta.env.DEV && window.__net?.client === this.client) {
      delete window.__net;
    }
  }

  /** Each patch replaces `snap` wholesale, so one validation per object serves every frame it is read. */
  private parsedSnapshot(): Snapshot | null {
    const { snap } = this.client.sharedState;
    if (snap !== this.snapSource) {
      this.snapSource = snap;
      this.snapParsed = isSnapshot(snap) ? snap : null;
    }
    return this.snapParsed;
  }

  /** Runs on every server message so a batch is never lost between two render frames. */
  private collectFx(): void {
    if (this.client.connectionStatus !== "connected") {
      return;
    }
    const seq = sharedCounter(this.client.sharedState["fxSeq"]);
    if (this.lastFxSeq === null) {
      this.lastFxSeq = seq;
      return;
    }
    if (seq === this.lastFxSeq) {
      return;
    }
    this.lastFxSeq = seq;
    this.pendingFx.push(...parseFxBatch(this.client.sharedState["fx"]));
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
