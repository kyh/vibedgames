import { PartySocket } from "partysocket";

import { trackClient } from "./net-stats.js";
import { applyPatch, cloneJson, clonePatch, diffState, readPatch } from "./patch.js";
import { ServerClock } from "./server-clock.js";
import type {
  ClaimMap,
  ClientMessage,
  JsonRecord,
  JsonValue,
  MultiplayerConnectionStatus,
  MultiplayerOptions,
  PatchOp,
  Player,
  PlayerMap,
  RoomInfo,
  RoomRules,
  SendEventOptions,
  ServerMessage,
  TickSync,
} from "./types.js";
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_INPUT_BYTES,
  MAX_TICK_HISTORY,
  OFFLINE_PLAYER_ID,
  RECONNECT_TOKEN_QUERY_PARAM,
  RESERVED_CLAIM_KEYS,
  ROOM_CAP_QUERY_PARAM,
  ROOM_RULES_QUERY_PARAM,
  TIME_PROBE_INTERVAL_MS,
} from "./types.js";
import type { MultiplayerSchemas, SchemaViolation } from "./validation.js";
import { MAX_MESSAGE_BYTES } from "./validation.js";

const normalizeIds = (ids: string | string[] | undefined) => {
  if (ids === undefined) {
    return;
  }

  return Array.isArray(ids) ? ids : [ids];
};

type OutboxItem =
  | { kind: "shared" }
  | { kind: "player"; patch: JsonRecord }
  | { data: EmitData; kind: "event" };

interface EmitData {
  event: string;
  payload: JsonValue;
  to?: string[];
  except?: string[];
}

const emitData = (
  event: string,
  payload: JsonValue,
  to: string[] | undefined,
  except: string[] | undefined,
) => {
  const data: EmitData = { event, payload };

  if (to) {
    data.to = to;
  }

  if (except) {
    data.except = except;
  }

  return data;
};

export type MultiplayerClientOptions = MultiplayerOptions & {
  /**
   * Shared state to seed the room with, applied exactly once per room by the
   * FIRST host of a still-empty room. It is never re-applied on host
   * promotion: when the host leaves mid-round and another client is promoted,
   * the room's live state wins — the new host must not reset it. Rooms that
   * already have shared state (observed via `sync` or any `state_patch`) are
   * never re-seeded.
   */
  initialState?: JsonRecord;
  /**
   * Optional state schemas (Standard Schema — zod v3.24+, valibot, arktype…).
   * Outgoing updates that fail validation are blocked before send; incoming
   * ones are dropped before merge. See `MultiplayerSchemas` for semantics.
   */
  schemas?: MultiplayerSchemas;
};

export interface MultiplayerSnapshot {
  connectionStatus: MultiplayerConnectionStatus;
  playerId: string | null;
  hostId: string | null;
  sharedState: JsonRecord;
  players: PlayerMap;
  /**
   * The room the client is actually connected to. Equals the configured
   * `room` until a cap is hit, then becomes the overflow sibling
   * (`{room}~2`, …) the server redirected this client into.
   */
  room: string;
  /** Who holds each claimed key. See `MultiplayerClient.claim`. */
  claims: ClaimMap;
  /** The room's lock and meta. See `MultiplayerClient.setRoomInfo`. */
  roomInfo: RoomInfo;
}

/** A tick room's clock: tick `n` starts at server time `epoch + n * ms`. */
export interface TickClock {
  epoch: number;
  ms: number;
  /** The last tick received. */
  n: number;
}

interface TickState extends TickClock {
  held: Map<string, JsonValue>;
  base: number;
  baseHeld: Map<string, JsonValue>;
  log: [number, Record<string, JsonValue>][];
}

const applyInputChanges = (held: Map<string, JsonValue>, changes: Record<string, JsonValue>) => {
  for (const [id, input] of Object.entries(changes)) {
    if (input === null) {
      held.delete(id);
    } else {
      held.set(id, input);
    }
  }
};

const TIME_PROBE_BURST_MS = [0, 100, 250, 500];
const TIME_PROBE_SETTLE_MS = 500;
const FALLBACK_FRAME_MS = 100;

const roomRules = (options: MultiplayerOptions) => {
  const rules: RoomRules = {};

  if (options.tickRate !== undefined) {
    rules.tickRate = options.tickRate;
  }

  if (options.interest !== undefined) {
    rules.interest = options.interest;
  }

  if (options.limits !== undefined) {
    rules.limits = options.limits;
  }

  if (options.lobby !== undefined) {
    rules.lobby = options.lobby;
  }

  return Object.keys(rules).length > 0 ? rules : null;
};

const UNPUBLISHED: RoomInfo = { locked: false, meta: {} };

type Listener = () => void;

const rafHost: typeof globalThis & {
  requestAnimationFrame?: (cb: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
} = globalThis;

const cryptoHost: typeof globalThis & {
  crypto?: { randomUUID?: () => string };
} = globalThis;

const generateReconnectToken = () => {
  const uuid = cryptoHost.crypto?.randomUUID?.();

  if (uuid) {
    return uuid;
  }

  return `t-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
};

const isPrimitive = (value: JsonValue | undefined) => !(value instanceof Object);

const changedKeys = (prev: JsonRecord, candidate: JsonRecord) => {
  let delta: JsonRecord | null = null;

  for (const key of Object.keys(candidate)) {
    const value = candidate[key];

    if (value === undefined) {
      continue;
    }

    if (isPrimitive(value) && isPrimitive(prev[key]) && Object.is(prev[key], value)) {
      continue;
    }

    delta ??= {};
    delta[key] = value;
  }

  return delta;
};

const toRecord = (value: JsonValue) =>
  value instanceof Object && !Array.isArray(value) ? value : {};

/** Functional-updater form accepted by the state setters. */
type StateUpdater = (prev: JsonRecord) => JsonRecord;

const isUpdaterFn = (updater: JsonRecord | StateUpdater): updater is StateUpdater =>
  typeof updater === "function";

/**
 * Framework-agnostic multiplayer client.
 *
 * Connects to a PartyServer-compatible backend via WebSocket.
 * Manages shared state, player state, and events.
 * Use directly in Phaser, Three.js, vanilla JS, or wrap with framework bindings.
 */
export class MultiplayerClient {
  private socket: PartySocket | null = null;
  private readonly listeners = new Set<Listener>();
  private initialStateApplied = false;
  private remoteStateSeen = false;
  private readonly options: MultiplayerClientOptions;
  private cap: number | null;
  private readonly reconnectToken = generateReconnectToken();
  private heartbeatRaf: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt = 0;
  private admitted = false;
  private fallbackElapsed = 0;
  private lastFrameAt: number | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly claimTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly outbox = new Map<string, OutboxItem>();
  private flushScheduled = false;
  private sharedDirty: Set<string> | "all" | null = null;
  private shadow: JsonRecord = {};
  private warnedAsyncSchema = false;
  private warnedRefusedPatch = false;
  private readonly clock = new ServerClock();
  private lastProbeAt = Number.NEGATIVE_INFINITY;
  private probeTimers: ReturnType<typeof setTimeout>[] = [];
  private _claims: ClaimMap = {};
  private _roomInfo: RoomInfo = UNPUBLISHED;
  private ticks: TickState | null = null;
  private heldInput: { value: JsonValue } | null = null;

  private _connectionStatus: MultiplayerConnectionStatus = "connecting";
  private _playerId: string | null = null;
  private _hostId: string | null = null;
  private _sharedState: JsonRecord;
  private _players: PlayerMap = {};
  private _room: string;
  private snapshot: MultiplayerSnapshot | null = null;
  private readonly untrack: () => void;
  private _onEvent: MultiplayerOptions["onEvent"];
  private _onClaim: MultiplayerOptions["onClaim"];
  private _onTick: MultiplayerOptions["onTick"];
  private _myState: JsonRecord = {};

  constructor(options: MultiplayerClientOptions) {
    this.options = options;
    this._sharedState = options.initialState ?? {};
    this._onEvent = options.onEvent;
    this._onClaim = options.onClaim;
    this._onTick = options.onTick;
    this._room = options.room;
    this.cap =
      options.maxPlayers !== undefined && options.maxPlayers !== 0 && options.maxPlayers > 0
        ? Math.floor(options.maxPlayers)
        : null;

    if (options.initialState) {
      this.passesSchema("sharedState", "outgoing", options.initialState);
    }

    if (options.offline === true) {
      this.enterOffline();
    } else {
      this.socket = this.dial();
      this.startHeartbeat();
    }

    this.untrack = trackClient({
      netInfo: () => ({
        isHost: this._playerId !== null && this._hostId === this._playerId,
        playerId: this._playerId,
        room: this._room,
        rttMs: Number.isNaN(this.clock.rtt) ? null : this.clock.rtt,
        status: this._connectionStatus,
      }),
    });
  }

  private dial() {
    const socket = new PartySocket({
      host: this.options.host,
      party: this.options.party,
      query: this.connectionQuery(),
      room: this.options.room,
    });

    socket.addEventListener("open", this.handleTransport);
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleTransport);
    socket.addEventListener("error", this.handleTransport);

    return socket;
  }

  private hangUp() {
    const { socket } = this;

    if (!socket) {
      return;
    }

    this.socket = null;
    socket.removeEventListener("open", this.handleTransport);
    socket.removeEventListener("message", this.handleMessage);
    socket.removeEventListener("close", this.handleTransport);
    socket.removeEventListener("error", this.handleTransport);
    socket.close();
  }

  private startHeartbeat() {
    const ping = (t: number) => {
      this.checkFallback(t);

      if (this._connectionStatus === "offline") {
        return;
      }

      if (t - this.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
        this.lastHeartbeatAt = t;

        if (this._connectionStatus === "connected") {
          this.send({ type: "heartbeat" });
        }
      }

      const probeEvery = this.clock.settled ? TIME_PROBE_INTERVAL_MS : TIME_PROBE_SETTLE_MS;

      if (t - this.lastProbeAt >= probeEvery) {
        this.lastProbeAt = t;
        this.probeTime();
      }
    };

    const raf = rafHost.requestAnimationFrame ? rafHost.requestAnimationFrame.bind(rafHost) : null;

    if (raf) {
      const loop = (t: number) => {
        this.heartbeatRaf = raf(loop);
        ping(t);
      };

      this.heartbeatRaf = raf(loop);
    } else {
      this.heartbeatTimer = setInterval(() => {
        if (this._connectionStatus === "connected") {
          this.send({ type: "heartbeat" });
        }
      }, HEARTBEAT_INTERVAL_MS);
      const { fallbackMs } = this.options;

      if (fallbackMs !== undefined) {
        this.fallbackTimer = setTimeout(() => {
          this.fallbackTimer = null;

          if (!this.admitted) {
            this.goOffline();
          }
        }, fallbackMs);
      }
    }
  }

  private checkFallback(t: number) {
    const { fallbackMs } = this.options;

    if (fallbackMs === undefined || this.admitted) {
      return;
    }

    const last = this.lastFrameAt ?? t;
    this.lastFrameAt = t;
    this.fallbackElapsed += Math.min(Math.max(0, t - last), FALLBACK_FRAME_MS);

    if (this.fallbackElapsed >= fallbackMs) {
      this.goOffline();
    }
  }

  private stopTimers() {
    for (const timer of this.probeTimers) {
      clearTimeout(timer);
    }

    this.probeTimers = [];

    if (this.heartbeatRaf !== null) {
      rafHost.cancelAnimationFrame?.(this.heartbeatRaf);
      this.heartbeatRaf = null;
    }

    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  private enterOffline() {
    this._connectionStatus = "offline";
    this._playerId = OFFLINE_PLAYER_ID;
    this._hostId = OFFLINE_PLAYER_ID;
    this._players = {
      [OFFLINE_PLAYER_ID]: { connected: true, id: OFFLINE_PLAYER_ID, state: this._myState },
    };
    this.ticks = null;
    this.clock.adoptLocal();
  }

  private connectionQuery() {
    const rules = roomRules(this.options);

    return {
      [RECONNECT_TOKEN_QUERY_PARAM]: this.reconnectToken,
      [ROOM_CAP_QUERY_PARAM]: this.cap === null ? undefined : String(this.cap),
      [ROOM_RULES_QUERY_PARAM]: rules ? JSON.stringify(rules) : undefined,
    };
  }

  private redirectTo(room: string, capacity: number) {
    this._room = room;
    this.cap = capacity > 0 ? capacity : this.cap;
    this._connectionStatus = this.admitted ? "reconnecting" : "connecting";
    this.initialStateApplied = false;
    this.remoteStateSeen = false;
    this._players = {};
    this._hostId = null;
    this._playerId = null;
    this._sharedState = this.options.initialState ?? {};
    this._claims = {};
    this._roomInfo = UNPUBLISHED;
    this.ticks = null;
    this.heldInput = null;
    this.outbox.clear();
    this.sharedDirty = null;
    this.shadow = {};

    this.socket?.updateProperties({ query: this.connectionQuery(), room });
    this.socket?.reconnect();

    this.notify();
  }

  get connectionStatus() {
    return this._connectionStatus;
  }
  get playerId() {
    return this._playerId;
  }
  get hostId() {
    return this._hostId;
  }
  get sharedState() {
    return this._sharedState;
  }
  get players() {
    return this._players;
  }
  get isHost() {
    return this._hostId !== null && this._hostId === this._playerId;
  }
  /** The room currently connected to (may be an overflow sibling). */
  get room() {
    return this._room;
  }
  /** The room's lock and meta, as its host last published them. */
  get roomInfo() {
    return this._roomInfo;
  }

  /**
   * A readonly snapshot of the current state: the same object until something
   * in it changes. `useSyncExternalStore` requires that — a fresh object on
   * every read looks like a change on every render, and React re-renders
   * until it gives up.
   */
  getSnapshot() {
    const last = this.snapshot;

    if (
      last !== null &&
      last.claims === this._claims &&
      last.connectionStatus === this._connectionStatus &&
      last.hostId === this._hostId &&
      last.playerId === this._playerId &&
      last.players === this._players &&
      last.room === this._room &&
      last.roomInfo === this._roomInfo &&
      last.sharedState === this._sharedState
    ) {
      return last;
    }

    this.snapshot = {
      claims: this._claims,
      connectionStatus: this._connectionStatus,
      hostId: this._hostId,
      playerId: this._playerId,
      players: this._players,
      room: this._room,
      roomInfo: this._roomInfo,
      sharedState: this._sharedState,
    };

    return this.snapshot;
  }

  /**
   * The room's shared clock — the server's, measured from here. Stamp updates,
   * deadlines and tick schedules with `serverNow()`: every client reads a stamp
   * as the same instant, and it survives host migration. Render remotes on a
   * per-sender `RemoteClock` instead (an Interpolator's default): a stamp
   * reaches you a whole relay after it was taken.
   */
  get serverClock() {
    return this.clock;
  }

  /**
   * Server time now (ms since the epoch). Until the first probe returns, and
   * offline if none ever did, it reads the local clock (`performance.now()`,
   * ms since the page loaded): don't stamp shared state with it then, or mix
   * it with `Date.now()`.
   */
  serverNow(localNow?: number) {
    return this.clock.now(localNow);
  }

  /** Fastest recent round trip to the server (ms); NaN until measured. */
  get rtt() {
    return this.clock.rtt;
  }

  /** Who holds each claimed key (server-arbitrated). */
  get claims() {
    return this._claims;
  }

  /** The player holding `key` now, or null (never claimed, released, or its TTL ran out). */
  ownerOf(key: string) {
    const claim = this._claims[key];

    if (!claim || (claim.until !== undefined && claim.until <= this.serverNow())) {
      return null;
    }

    return claim.owner;
  }

  /**
   * Ask the server for `key` — first come, first served, with no host round
   * trip and no host advantage. Every client hears the grant through
   * `onClaim(key, owner)` and `claims`; a refused claimer alone hears the
   * current owner. Act on the claim optimistically and undo it if `onClaim`
   * names someone else. `ttlMs` (positive) releases it automatically.
   * Offline, nobody races: the claim is granted before this returns.
   */
  claim(key: string, options?: { ttlMs?: number }) {
    if (RESERVED_CLAIM_KEYS.includes(key)) {
      console.warn(`"${key}" is reserved; the server refuses it as a claim key.`);

      return;
    }

    const ttl = options?.ttlMs;

    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
      console.warn(
        `claim("${key}"): ttlMs ${ttl} is not a positive number; the server refuses it.`,
      );

      return;
    }

    if (this._connectionStatus === "offline") {
      this.clearClaimTimer(key);

      if (ttl !== undefined) {
        this.claimTimers.set(
          key,
          setTimeout(() => {
            this.release(key);
          }, ttl),
        );
      }

      this.applyClaim(
        key,
        OFFLINE_PLAYER_ID,
        ttl === undefined ? undefined : this.serverNow() + ttl,
      );
      this.notify();

      return;
    }

    this.flushOutbox();
    this.send({ data: ttl === undefined ? { key } : { key, ttl }, type: "claim" });
  }

  /** Give `key` back. Its owner may; the host may release any key. */
  release(key: string) {
    if (this._connectionStatus === "offline") {
      this.clearClaimTimer(key);

      if (key in this._claims) {
        this.applyClaim(key, null);
        this.notify();
      }

      return;
    }

    this.flushOutbox();
    this.send({ data: { key }, type: "release" });
  }

  /** Host only: release every key starting with `prefix` ("" clears them all) — a new round. */
  clearClaims(prefix = "") {
    if (this._connectionStatus === "offline") {
      for (const key of this.claimTimers.keys()) {
        if (key.startsWith(prefix)) {
          this.clearClaimTimer(key);
        }
      }

      this.applyClaimsCleared(prefix);
      this.notify();

      return;
    }

    this.flushOutbox();
    this.send({ data: { prefix }, type: "clear_claims" });
  }

  private clearClaimTimer(key: string) {
    const timer = this.claimTimers.get(key);

    if (timer !== undefined) {
      clearTimeout(timer);
      this.claimTimers.delete(key);
    }
  }

  /** A tick room's clock, or null (no `tickRate`, or not yet synced). */
  get tickClock() {
    const { ticks } = this;

    return ticks ? { epoch: ticks.epoch, ms: ticks.ms, n: ticks.n } : null;
  }

  /**
   * Tick rooms: every player's held input as of tick `at` (default: the last
   * tick received) — what a late joiner starts from, or replays a world
   * snapshot stamped with an earlier tick from. Null outside the history the
   * room keeps (MAX_TICK_HISTORY ticks) or outside a tick room.
   */
  tickInputs(at?: number) {
    const { ticks } = this;
    const tick = at ?? ticks?.n ?? 0;

    if (!ticks || tick < ticks.base || tick > ticks.n) {
      return null;
    }

    if (tick === ticks.n) {
      return Object.fromEntries(ticks.held);
    }

    const held = new Map(ticks.baseHeld);

    for (const [n, changes] of ticks.log) {
      if (n > tick) {
        break;
      }

      applyInputChanges(held, changes);
    }

    return Object.fromEntries(held);
  }

  /** The tick the server is on at `localNow`, by the server clock; NaN outside tick rooms. */
  serverTick(localNow?: number) {
    const { ticks } = this;

    return ticks ? Math.floor((this.serverNow(localNow) - ticks.epoch) / ticks.ms) : Number.NaN;
  }

  /**
   * Tick rooms: this player's input from tick `n` on (default: the server's
   * next tick; a past tick is moved to the next). It stays held until the next
   * `sendInput`, so send on change. While the connection is down it is only
   * held, and the reconnect sends it.
   */
  sendInput(input: JsonValue, n?: number) {
    if (JSON.stringify(input).length > MAX_INPUT_BYTES) {
      console.warn(`Input over ${MAX_INPUT_BYTES} characters; the server would drop it.`);

      return;
    }

    this.heldInput = { value: input };
    this.flushOutbox();

    if (!this.dropped) {
      this.send({ data: n === undefined ? { v: input } : { n, v: input }, type: "input" });
    }
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: Listener) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Update shared state. The object form replaces each key it names (the rest
   * stay); the function form returns the whole next state, and a key it
   * leaves out is deleted. Either way only what changed rides the wire, down
   * to the leaf: the client diffs the result against the room's copy and
   * sends path ops (see patch.ts), once per task however many writes it
   * made. The write is read when that batch leaves, and what you pass is kept
   * as the shared state: never pass an object you go on mutating (a live
   * world), or it leaves as it stands then. Nothing is sent while the
   * connection is down: a host's reconnect re-sends whatever the server holds
   * differently.
   */
  updateSharedState(updater: JsonRecord | StateUpdater) {
    const prev = this._sharedState;
    const next = isUpdaterFn(updater) ? updater(prev) : { ...prev, ...updater };

    if (!this.passesSchema("sharedState", "outgoing", next)) {
      return;
    }

    this._sharedState = next;

    if (this._connectionStatus !== "offline") {
      this.markShared(isUpdaterFn(updater) ? "all" : Object.keys(updater));
    }

    this.notify();
  }

  /**
   * Update this player's state (merged with current). Only changed keys ride
   * the wire, and nothing while the connection is down: the reconnect
   * re-sends the whole state.
   */
  updateMyState(updater: JsonRecord | StateUpdater) {
    if (this._playerId === null || this._playerId === "") {
      return;
    }

    const current = this._players[this._playerId]?.state ?? {};
    const next = isUpdaterFn(updater) ? updater(current) : { ...current, ...updater };

    if (!this.passesSchema("playerState", "outgoing", next)) {
      return;
    }

    const existing = this._players[this._playerId] ?? { id: this._playerId };
    this._players = {
      ...this._players,
      [this._playerId]: { ...existing, state: next },
    };
    this._myState = next;

    const delta = changedKeys(current, isUpdaterFn(updater) ? next : updater);

    if (delta && !this.dropped && this._connectionStatus !== "offline") {
      const pending = this.outbox.get("player");
      this.enqueue("player", {
        kind: "player",
        patch: pending?.kind === "player" ? { ...pending.patch, ...delta } : delta,
      });
    }

    this.notify();
  }

  /**
   * Send a custom event. By default it is broadcast to all players (including
   * this one); pass `to`/`except` to target specific player ids instead — e.g.
   * `sendEvent("you_died", { by }, { to: victimId })` or
   * `sendEvent("explosion", at, { except: myId })`.
   *
   * With `{ coalesce: true }`, rapid same-type events collapse into one wire
   * message carrying the latest payload, sent on the next microtask. Pending
   * coalesced events are flushed ahead of every other outgoing game message
   * (state patches, non-coalesced events), so opting in bounds message rate
   * without ever reordering an event relative to the state it annotates.
   * Coalescing composes with targeting: same-type events aimed at different
   * recipients coalesce independently, each keeping its own audience.
   */
  sendEvent(event: string, payload: JsonValue, options?: SendEventOptions) {
    const to = normalizeIds(options?.to);
    const except = normalizeIds(options?.except);

    if (this._connectionStatus === "offline") {
      if (
        (to === undefined || to.includes(OFFLINE_PLAYER_ID)) &&
        except?.includes(OFFLINE_PLAYER_ID) !== true
      ) {
        this._onEvent?.(event, payload, OFFLINE_PLAYER_ID);
      }

      return;
    }

    if (options?.coalesce === true) {
      const key = `event\u0000${event}\u0000${to?.join(",") ?? ""}\u0000${except?.join(",") ?? ""}`;
      this.enqueue(key, { data: emitData(event, payload, to, except), kind: "event" });

      return;
    }

    this.flushOutbox();
    this.send({ data: emitData(event, payload, to, except), type: "emit" });
  }

  /**
   * An intent for the host alone. The host — an offline client too — hands it
   * to its own `onEvent` at once instead of bouncing it off the server; a
   * guest sends it to the host. Dropped while no host is known.
   */
  sendToHost(event: string, payload: JsonValue) {
    const me = this._playerId;

    if (me !== null && this._hostId === me) {
      this._onEvent?.(event, payload, me);

      return;
    }

    const host = this._hostId;

    if (host !== null) {
      this.sendEvent(event, payload, { to: host });
    }
  }

  /**
   * Host only — the server ignores anyone else: lock or unlock the room, or
   * replace its meta. A locked room admits no new players; they go on to an
   * overflow sibling, as from a full room, while a dropped player still
   * reclaims its seat. `meta` (at most MAX_ROOM_META_CHARS of JSON) is what
   * a lobby lists about the room: a mode, a map, a round. Everyone in the
   * room reads both on `roomInfo` once the server has them.
   */
  setRoomInfo(info: Partial<RoomInfo>) {
    if (this._connectionStatus === "offline") {
      this._roomInfo = {
        locked: info.locked ?? this._roomInfo.locked,
        meta: info.meta ?? this._roomInfo.meta,
      };
      this.notify();

      return;
    }

    this.flushOutbox();
    this.send({ data: info, type: "room_info" });
  }

  get onEvent() {
    return this._onEvent;
  }

  /** Set the onEvent callback. */
  set onEvent(fn: MultiplayerOptions["onEvent"]) {
    this._onEvent = fn;
  }

  get onClaim() {
    return this._onClaim;
  }

  /** Set the onClaim callback. */
  set onClaim(fn: MultiplayerOptions["onClaim"]) {
    this._onClaim = fn;
  }

  get onTick() {
    return this._onTick;
  }

  /** Set the onTick callback. */
  set onTick(fn: MultiplayerOptions["onTick"]) {
    this._onTick = fn;
  }

  /**
   * Leave the room, if in one, and carry on as a local room of one — what
   * `fallbackMs` does when no room answers, and what a "play solo" button
   * wants. This client becomes the only player and the host, state updates
   * apply locally, events and host intents loop back to `onEvent`, claims are
   * granted at once, and `serverNow()` keeps the timebase it had (the local
   * clock, if it never measured the server's). Shared state and this
   * player's state carry over; claims held in the room are released, and
   * tick rooms stop ticking. The leave is deliberate, so the room frees the
   * seat at once. A new client is the only way back online.
   */
  goOffline() {
    if (this._connectionStatus === "offline") {
      return;
    }

    this.hangUp();
    this.stopTimers();
    this.outbox.clear();
    this.sharedDirty = null;
    const claimsBefore = this._claims;
    this._claims = {};
    this.enterOffline();
    this.reportClaimChanges(claimsBefore);
    this.notify();
  }

  /**
   * Close the socket the way a dropped network would, without leaving the
   * room: the seat is held for the reconnect window and nothing redials
   * until `redial()`. For rehearsing how a game rides out a blip.
   */
  dropConnection(code = 4000) {
    this.socket?.close(code);
  }

  /** Reopen the socket `dropConnection()` closed. */
  redial() {
    this.socket?.reconnect();
  }

  /** Disconnect and clean up. */
  destroy() {
    this.untrack();
    this.flushOutbox();
    this.stopTimers();

    for (const timer of this.claimTimers.values()) {
      clearTimeout(timer);
    }

    this.claimTimers.clear();
    this.hangUp();
    this.listeners.clear();
  }

  private send(message: ClientMessage) {
    this.socket?.send(JSON.stringify(message));
  }

  private get dropped() {
    return this._connectionStatus === "reconnecting";
  }

  private probeTime() {
    if (this._connectionStatus === "connected") {
      this.send({ data: { c: performance.now() }, type: "time" });
    }
  }

  private enqueue(key: string, item: OutboxItem) {
    const [pending] = this.outbox.values();

    if (pending !== undefined && (pending.kind === "event") !== (item.kind === "event")) {
      this.flushOutbox();
    }

    this.outbox.set(key, item);

    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushScheduled = false;
        this.flushOutbox();
      });
    }
  }

  private markShared(keys: string[] | "all") {
    if (keys === "all" || this.sharedDirty === "all") {
      this.sharedDirty = "all";
    } else {
      this.sharedDirty ??= new Set();

      for (const key of keys) {
        this.sharedDirty.add(key);
      }
    }

    this.enqueue("shared", { kind: "shared" });
  }

  private flushOutbox() {
    if (this.outbox.size === 0) {
      return;
    }

    const items = [...this.outbox.values()];
    this.outbox.clear();

    for (const item of items) {
      if (item.kind === "shared") {
        this.sendSharedDiff();
      } else if (item.kind === "player") {
        if (!this.dropped) {
          this.send({ data: item.patch, type: "player_state_patch" });
        }
      } else {
        this.send({ data: item.data, type: "emit" });
      }
    }
  }

  private sendSharedDiff() {
    const dirty = this.sharedDirty;

    if (dirty === null || this._connectionStatus !== "connected") {
      return;
    }

    this.sharedDirty = null;
    this.sendOps(diffState(this.shadow, this._sharedState, dirty === "all" ? undefined : dirty));
  }

  private sendOps(ops: PatchOp[]) {
    if (ops.length === 0) {
      return;
    }

    const message: ClientMessage = { data: ops, type: "state_patch" };
    const raw = JSON.stringify(message);

    const read =
      raw.length > MAX_MESSAGE_BYTES
        ? `${raw.length} characters, past the ${MAX_MESSAGE_BYTES} cap`
        : readPatch(ops);

    if (!Array.isArray(read)) {
      if (!this.warnedRefusedPatch) {
        this.warnedRefusedPatch = true;
        console.warn(
          `[multiplayer] shared state write not sent — the server would refuse it: ${read}`,
        );
      }

      this.rewindRefused(ops);

      return;
    }

    this.socket?.send(raw);
    this.shadow = applyPatch(this.shadow, clonePatch(ops));
  }

  private rewindRefused(ops: PatchOp[]) {
    const keys = new Set<string>();

    for (const [path] of ops) {
      const [key] = path;

      if (key === undefined) {
        this._sharedState = toRecord(cloneJson(this.shadow));
        this.notify();

        return;
      }

      keys.add(String(key));
    }

    const next: JsonRecord = { ...this._sharedState };

    for (const key of keys) {
      const held = this.shadow[key];

      if (held === undefined) {
        Reflect.deleteProperty(next, key);
      } else {
        next[key] = cloneJson(held);
      }
    }

    this._sharedState = next;
    this.notify();
  }

  private passesSchema(
    channel: SchemaViolation["channel"],
    direction: SchemaViolation["direction"],
    state: JsonRecord,
    from?: string,
  ) {
    const { schemas } = this.options;
    const schema = channel === "sharedState" ? schemas?.sharedState : schemas?.playerState;

    if (!schema) {
      return true;
    }

    if (Object.keys(state).length === 0) {
      return true;
    }

    const result = schema["~standard"].validate(state);

    if (result instanceof Promise) {
      if (!this.warnedAsyncSchema) {
        this.warnedAsyncSchema = true;
        console.warn(
          "[multiplayer] async schemas are not supported — validation skipped. Use a synchronous schema.",
        );
      }

      return true;
    }

    if (!result.issues) {
      return true;
    }

    const violation: SchemaViolation = {
      channel,
      data: state,
      direction,
      issues: result.issues,
    };

    if (from !== undefined) {
      violation.from = from;
    }

    if (schemas?.onViolation) {
      schemas.onViolation(violation);
    } else {
      console.warn(`[multiplayer] ${direction} ${channel} failed schema validation`, result.issues);
    }

    return false;
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private readonly handleTransport = () => {
    this._connectionStatus = this.admitted ? "reconnecting" : "connecting";
    this.notify();
  };

  private maybeSeedInitialState(hostId: string) {
    if (
      hostId === this.socket?.id &&
      this.options.initialState &&
      !this.initialStateApplied &&
      !this.remoteStateSeen
    ) {
      this.initialStateApplied = true;
      this.flushOutbox();
      this.sendOps(diffState(this.shadow, this._sharedState));
    }
  }

  private applySync(data: Extract<ServerMessage, { type: "sync" }>["data"]) {
    const wasHost = this._hostId !== null && this._hostId === this._playerId;
    this._connectionStatus = "connected";
    this.admitted = true;
    this._playerId = this.socket?.id ?? null;
    this._hostId = data.hostId;
    this._players = data.players;
    const claimsBefore = this._claims;
    this._claims = data.claims;
    this._roomInfo = data.info;
    this.syncTicks(data.tick);

    for (const timer of this.probeTimers) {
      clearTimeout(timer);
    }

    this.probeTimers = TIME_PROBE_BURST_MS.map((delay) =>
      setTimeout(() => {
        this.probeTime();
      }, delay),
    );
    this.lastProbeAt = performance.now();

    if (Object.keys(data.state).length > 0) {
      this.remoteStateSeen = true;
    }

    this.shadow = toRecord(cloneJson(data.state));

    if (wasHost && data.hostId === this._playerId) {
      this.reassertWorld(data.state);
    } else {
      const merged =
        Object.keys(this._sharedState).length === 0
          ? data.state
          : { ...this._sharedState, ...data.state };

      if (this.passesSchema("sharedState", "incoming", merged)) {
        this._sharedState = merged;
      }
    }

    this.maybeSeedInitialState(data.hostId);
    this.sendSharedDiff();

    if (this._playerId !== null && this._playerId !== "" && Object.keys(this._myState).length > 0) {
      this._players = {
        ...this._players,
        [this._playerId]: {
          ...this._players[this._playerId],
          id: this._playerId,
          state: this._myState,
        },
      };
      this.send({ data: this._myState, type: "player_state_patch" });
    }

    this.reportClaimChanges(claimsBefore);
  }

  private reportClaimChanges(before: ClaimMap) {
    const after = this._claims;

    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const owner = after[key]?.owner ?? null;

      if ((before[key]?.owner ?? null) !== owner) {
        this._onClaim?.(key, owner);
      }
    }
  }

  private reassertWorld(server: JsonRecord) {
    const ops = diffState(server, this._sharedState, Object.keys(this._sharedState));
    this._sharedState = { ...server, ...this._sharedState };
    this.sendOps(ops);
  }

  private applyClaim(key: string, owner: string | null, until?: number) {
    if (owner === null) {
      const { [key]: _released, ...remaining } = this._claims;
      this._claims = remaining;
    } else {
      this._claims = { ...this._claims, [key]: until === undefined ? { owner } : { owner, until } };
    }

    this._onClaim?.(key, owner);
  }

  private syncTicks(sync: TickSync | null) {
    const previous = this.ticks;

    if (!sync) {
      this.ticks = null;

      return;
    }

    if (
      previous &&
      previous.epoch === sync.epoch &&
      previous.n >= sync.base &&
      previous.n <= sync.n
    ) {
      const missed = new Map(sync.log);

      for (let n = previous.n + 1; n <= sync.n; n += 1) {
        this.applyTick(n, missed.get(n) ?? {});
      }
    } else {
      const baseHeld = new Map(Object.entries(sync.held));
      const held = new Map(baseHeld);

      for (const [, changes] of sync.log) {
        applyInputChanges(held, changes);
      }

      this.ticks = {
        base: sync.base,
        baseHeld,
        epoch: sync.epoch,
        held,
        log: [...sync.log],
        ms: sync.ms,
        n: sync.n,
      };
    }

    if (this.heldInput) {
      this.sendInput(this.heldInput.value);
    }
  }

  private applyTick(n: number, changed: Record<string, JsonValue>) {
    const { ticks } = this;

    if (!ticks || n <= ticks.n) {
      return;
    }

    applyInputChanges(ticks.held, changed);
    ticks.n = n;

    if (Object.keys(changed).length > 0) {
      ticks.log.push([n, changed]);
    }

    let [oldest] = ticks.log;

    while (oldest && oldest[0] <= n - MAX_TICK_HISTORY) {
      ticks.log.shift();
      applyInputChanges(ticks.baseHeld, oldest[1]);
      [ticks.base] = oldest;
      [oldest] = ticks.log;
    }

    ticks.base = Math.max(ticks.base, n - MAX_TICK_HISTORY);
    this._onTick?.({ changed, inputs: Object.fromEntries(ticks.held), n });
  }

  private readonly handleMessage = (event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data) as ServerMessage;

      if (this.applyMessage(message)) {
        this.notify();
      }
    } catch (error) {
      console.error("Failed to process multiplayer message", error);
    }
  };

  private applyMessage(message: ServerMessage) {
    switch (message.type) {
      case "ping": {
        this.send({ type: "pong" });

        return true;
      }

      case "sync": {
        this.applySync(message.data);

        return true;
      }

      case "player_joined": {
        this._players = { ...this._players, [message.data.id]: message.data };

        return true;
      }

      case "player_left": {
        const { [message.data.id]: _left, ...remaining } = this._players;
        this._players = remaining;

        return true;
      }

      case "host": {
        this._hostId = message.data.id;
        this.maybeSeedInitialState(message.data.id);

        return true;
      }

      case "state_patch": {
        if (!Array.isArray(message.data)) {
          return false;
        }

        this.remoteStateSeen = true;
        const merged = applyPatch(this._sharedState, message.data);

        if (this.passesSchema("sharedState", "incoming", merged)) {
          this._sharedState = merged;
        }

        this.shadow = applyPatch(this.shadow, clonePatch(message.data));

        return true;
      }

      case "player_state": {
        this.mergePlayerState(message.data.id, message.data.state);

        return true;
      }

      case "player_connection": {
        this.patchPlayer(message.data.id, { connected: message.data.connected });

        return true;
      }

      case "player_visibility": {
        this.patchPlayer(message.data.id, { visible: message.data.visible });

        return true;
      }

      case "event": {
        this._onEvent?.(message.data.event, message.data.payload, message.data.from);

        return true;
      }

      case "time": {
        this.clock.sample(message.data.c, message.data.s);

        return false;
      }

      case "claim": {
        this.applyClaim(message.data.key, message.data.owner, message.data.until);

        return true;
      }

      case "claims_cleared": {
        this.applyClaimsCleared(message.data.prefix);

        return true;
      }

      case "tick": {
        this.applyTick(message.data.n, message.data.i);

        return false;
      }

      case "room_info": {
        this._roomInfo = message.data;

        return true;
      }

      case "room_full": {
        this.redirectTo(message.data.room, message.data.capacity);

        return false;
      }

      default: {
        return true;
      }
    }
  }

  private mergePlayerState(id: string, state: JsonRecord) {
    const existing = this._players[id] ?? { id };
    const mergedState = { ...existing.state, ...state };

    if (!this.passesSchema("playerState", "incoming", mergedState, id)) {
      return;
    }

    this._players = { ...this._players, [id]: { ...existing, state: mergedState } };
  }

  private patchPlayer(id: string, flags: Pick<Player, "connected" | "visible">) {
    const known = this._players[id];

    if (known) {
      this._players = { ...this._players, [id]: { ...known, ...flags } };
    }
  }

  private applyClaimsCleared(prefix: string) {
    const remaining: ClaimMap = {};
    const released: string[] = [];

    for (const [key, claim] of Object.entries(this._claims)) {
      if (key.startsWith(prefix)) {
        released.push(key);
      } else {
        remaining[key] = claim;
      }
    }

    this._claims = remaining;

    for (const key of released) {
      this._onClaim?.(key, null);
    }
  }
}
