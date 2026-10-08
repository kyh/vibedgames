import { PartySocket } from "partysocket";

import { ServerClock } from "./server-clock.js";
import type {
  ClaimMap,
  ClientMessage,
  JsonRecord,
  JsonValue,
  MultiplayerConnectionStatus,
  MultiplayerOptions,
  Player,
  PlayerMap,
  RoomRules,
  SendEventOptions,
  ServerMessage,
  TickSync,
} from "./types.js";
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_INPUT_BYTES,
  MAX_TICK_HISTORY,
  RECONNECT_TOKEN_QUERY_PARAM,
  ROOM_CAP_QUERY_PARAM,
  ROOM_RULES_QUERY_PARAM,
  TIME_PROBE_INTERVAL_MS,
} from "./types.js";
import type { MultiplayerSchemas, SchemaViolation } from "./validation.js";

/** Accept a single id or a list; undefined stays undefined so the field can be
 *  omitted from the wire message entirely. */
const normalizeIds = (ids: string | string[] | undefined): string[] | undefined => {
  if (ids === undefined) {
    return undefined;
  }
  return Array.isArray(ids) ? ids : [ids];
};

/** A coalesced event waiting for the next microtask flush. */
interface PendingEvent {
  event: string;
  payload: JsonValue;
  to?: string[];
  except?: string[];
}

interface EmitData {
  event: string;
  payload: JsonValue;
  to?: string[];
  except?: string[];
}

/** Emit-message data with targeting fields omitted (not undefined) when
 *  untargeted, so plain broadcasts stay byte-identical to the pre-targeting
 *  wire protocol. */
const emitData = (
  event: string,
  payload: JsonValue,
  to: string[] | undefined,
  except: string[] | undefined,
): EmitData => {
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
}

/** A tick room's clock: tick `n` starts at server time `epoch + n * ms`. */
export interface TickClock {
  epoch: number;
  ms: number;
  /** The last tick received. */
  n: number;
}

/** A tick room as this client follows it: the clock, held inputs, and the recent history. */
interface TickState extends TickClock {
  /** Every player's held input as of tick `n`. */
  held: Map<string, JsonValue>;
  /** The tick the history starts at, and every held input as of it. */
  base: number;
  baseHeld: Map<string, JsonValue>;
  /** Each tick after `base` whose inputs changed, oldest first. */
  log: [number, Record<string, JsonValue>][];
}

/** Fold one tick's changes into held inputs (null clears a player's). */
const applyInputChanges = (
  held: Map<string, JsonValue>,
  changes: Record<string, JsonValue>,
): void => {
  for (const [id, input] of Object.entries(changes)) {
    if (input === null) {
      held.delete(id);
    } else {
      held.set(id, input);
    }
  }
};

/** Probes sent right after admission, before the slow cadence (ms after sync). */
const TIME_PROBE_BURST_MS = [0, 100, 250, 500];

/** The room rules this client advertises (query JSON), or null for none. */
const roomRules = (options: MultiplayerOptions): RoomRules | null => {
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
  return Object.keys(rules).length > 0 ? rules : null;
};

type Listener = () => void;

/** rAF/cAF are browser-only, but this SDK is also bundled where the DOM lib is
 *  absent (the party Worker typechecks this source). Reach them through a
 *  structurally-typed view of globalThis so no DOM lib is required. */
const rafHost: typeof globalThis & {
  requestAnimationFrame?: (cb: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
} = globalThis;

/** Same structural-view trick for `crypto` (secure contexts only expose
 *  randomUUID, and non-browser bundles may lack the DOM lib entirely). */
const cryptoHost: typeof globalThis & {
  crypto?: { randomUUID?: () => string };
} = globalThis;

/**
 * Secret presented on every (re)connect so the server can hand this client its
 * held seat back after a transport drop. Deliberately NOT the connection id:
 * ids are broadcast to every peer, so an id-based reclaim would let any player
 * hijack a disconnected peer's seat. Falls back to Math.random outside secure
 * contexts — weaker, but still unguessable enough for a 30s window.
 */
const generateReconnectToken = (): string => {
  const uuid = cryptoHost.crypto?.randomUUID?.();
  if (uuid) {
    return uuid;
  }
  return `t-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
};

/** True for immutable JSON values (primitives), where `Object.is` equality proves "unchanged". */
const isPrimitive = (value: JsonValue | undefined): boolean => !(value instanceof Object);

/**
 * The keyed delta of `candidate` against `prev`: the keys actually worth
 * sending, or `null` when nothing changed. The whole sync protocol is
 * shallow-merge on every hop (server state, server broadcast, client mirrors),
 * so any key that provably didn't change can stay off the wire entirely.
 *
 * A key is suppressed only when both sides hold the same *primitive* —
 * primitives are immutable, so `Object.is` equality is proof. Objects and
 * arrays are always included: a same-reference value may have been mutated in
 * place, and dropping it would lose the update.
 */
const changedKeys = (prev: JsonRecord, candidate: JsonRecord): JsonRecord | null => {
  let delta: JsonRecord | null = null;
  for (const key of Object.keys(candidate)) {
    const value = candidate[key];
    // A runtime `undefined` can't ride JSON — stringify would drop the key.
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

/** Functional-updater form accepted by the state setters. */
type StateUpdater = (prev: JsonRecord) => JsonRecord;

// instanceof rather than typeof (banned): updaters are always constructed in
// the caller's realm alongside the client, so the realm caveat doesn't bite.
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
  private socket: PartySocket;
  private listeners = new Set<Listener>();
  private initialStateApplied = false;
  /** True once authoritative shared state has been observed from the server —
   *  a non-empty `sync` snapshot or any `state_patch`. Local `_sharedState`
   *  can't serve as this signal: the constructor pre-seeds it with
   *  `initialState`, so it is non-empty even before the room has any state.
   *  Guards `initialState` so a client promoted to host mid-round never
   *  re-seeds a room that already has live state (issue #240). */
  private remoteStateSeen = false;
  private options: MultiplayerClientOptions;
  /** True while we reconnect to an overflow room, to mask the interim close. */
  private redirecting = false;
  /** Effective player cap advertised to the server (server-authoritative on overflow). */
  private cap: number | null;
  /** Reconnection secret for this client instance — see generateReconnectToken. */
  private reconnectToken = generateReconnectToken();
  /** Liveness ping driven by requestAnimationFrame so it PAUSES when the tab is
   *  hidden/asleep — exactly when the game loop also stalls — letting the server
   *  migrate host off a backgrounded/dead client. Falls back to setInterval where
   *  rAF isn't available (non-browser). */
  private heartbeatRaf: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt = 0;
  /** Coalesced events awaiting the microtask flush — latest payload per
   *  event + target signature. Flushed before any other outgoing game message
   *  so coalescing can delay an event but never reorder it relative to state
   *  patches. */
  private pendingCoalesced = new Map<string, PendingEvent>();
  private coalesceFlushScheduled = false;
  /** One warning per client for async schemas — validation must stay sync. */
  private warnedAsyncSchema = false;
  /** The room's shared server time, measured by `time` probes. */
  private readonly clock = new ServerClock();
  private lastProbeAt = Number.NEGATIVE_INFINITY;
  private probeTimers: ReturnType<typeof setTimeout>[] = [];
  private _claims: ClaimMap = {};
  /** Tick rooms: the tick clock and every player's held input as of tick `n`. */
  private ticks: TickState | null = null;
  /** This player's held input, re-sent after a reconnect (the server clears a dropped player's). */
  private heldInput: { value: JsonValue } | null = null;

  private _connectionStatus: MultiplayerConnectionStatus = "connecting";
  private _playerId: string | null = null;
  private _hostId: string | null = null;
  private _sharedState: JsonRecord;
  private _players: PlayerMap = {};
  private _room: string;
  private _onEvent: MultiplayerOptions["onEvent"];
  private _onClaim: MultiplayerOptions["onClaim"];
  private _onTick: MultiplayerOptions["onTick"];
  /** Our own player state, held outside `_players` so it survives a reconnect
   *  (which replaces `_players` wholesale and hands us a new player id) and can
   *  be re-announced to the fresh server-side connection. */
  private _myState: JsonRecord = {};

  constructor(options: MultiplayerClientOptions) {
    this.options = options;
    this._sharedState = options.initialState ?? {};
    this._onEvent = options.onEvent;
    this._onClaim = options.onClaim;
    this._onTick = options.onTick;
    this._room = options.room;
    this.cap = options.maxPlayers && options.maxPlayers > 0 ? Math.floor(options.maxPlayers) : null;

    // Surface an invalid initialState immediately, at construction, where the
    // author is looking. Report-only: blocking the seed would leave the room
    // permanently empty, which bricks a game harder than imperfect data.
    if (options.initialState) {
      this.passesSchema("sharedState", "outgoing", options.initialState);
    }

    this.socket = new PartySocket({
      host: options.host,
      party: options.party,
      query: this.connectionQuery(),
      room: options.room,
    });

    // Listeners are registered once and survive PartySocket's reconnects,
    // including the room switch we trigger on overflow (updateProperties +
    // reconnect). No need to re-attach them per connection.
    this.socket.addEventListener("open", this.handleOpen);
    this.socket.addEventListener("message", this.handleMessage);
    this.socket.addEventListener("close", this.handleClose);
    this.socket.addEventListener("error", this.handleError);

    this.startHeartbeat();
  }

  /** Drive the heartbeat off rAF so a hidden/asleep tab stops pinging (its rAF is
   *  paused), and the server promptly migrates host away from it. */
  private startHeartbeat(): void {
    const ping = (t: number): void => {
      if (t - this.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
        this.lastHeartbeatAt = t;
        if (this._connectionStatus === "connected") {
          this.send({ type: "heartbeat" });
        }
      }
      if (t - this.lastProbeAt >= TIME_PROBE_INTERVAL_MS) {
        this.lastProbeAt = t;
        this.probeTime();
      }
    };
    // bind to the host so browsers don't throw "Illegal invocation" on a detached rAF
    const raf = rafHost.requestAnimationFrame ? rafHost.requestAnimationFrame.bind(rafHost) : null;
    if (raf) {
      const loop = (t: number): void => {
        this.heartbeatRaf = raf(loop);
        ping(t);
      };
      this.heartbeatRaf = raf(loop);
    } else {
      // non-browser fallback (SSR/tests) — liveness isn't meaningful there anyway
      this.heartbeatTimer = setInterval(() => {
        if (this._connectionStatus === "connected") {
          this.send({ type: "heartbeat" });
        }
      }, HEARTBEAT_INTERVAL_MS);
    }
  }

  /** Query params sent on every (re)connect: reconnect token, the effective
   *  cap, and the room rules. */
  private connectionQuery() {
    const rules = roomRules(this.options);
    // PartySocket leaves nil params out of the URL.
    return {
      [RECONNECT_TOKEN_QUERY_PARAM]: this.reconnectToken,
      [ROOM_CAP_QUERY_PARAM]: this.cap === null ? undefined : String(this.cap),
      [ROOM_RULES_QUERY_PARAM]: rules ? JSON.stringify(rules) : undefined,
    };
  }

  /**
   * Move to an overflow room after the current room reported it was full.
   * Uses PartySocket's own `updateProperties` + `reconnect` so the rebuilt
   * URL points at the overflow room before reconnecting — the library's
   * reconnect then naturally targets the new room (no risk of looping back
   * into the full one). We carry the server's authoritative `capacity`
   * forward so every overflow shard inherits the same cap as the room that
   * rejected us (a client can't open a looser/uncapped shard). The full room
   * never admitted us, so reset to the caller-provided defaults; a fresh room
   * must not inherit optimistic writes, and we re-seed as host if we land
   * there first.
   */
  private redirectTo(room: string, capacity: number): void {
    this._room = room;
    this.cap = capacity > 0 ? capacity : this.cap;
    this._connectionStatus = "connecting";
    this.initialStateApplied = false;
    this.remoteStateSeen = false;
    this._players = {};
    this._hostId = null;
    this._playerId = null;
    this._sharedState = this.options.initialState ?? {};
    this._claims = {};
    this.ticks = null;
    this.heldInput = null;
    // Queued for a room that never admitted us — don't leak them into the new one.
    this.pendingCoalesced.clear();

    // Mask only the one synchronous close that reconnect() dispatches for the
    // old connection. The server's async close(4001) never reaches
    // handleClose — reconnect()'s internal disconnect removes the old socket's
    // listeners first — so clearing synchronously is safe and lets genuine
    // overflow-connection failures still surface as error/disconnected.
    this.redirecting = true;
    this.socket.updateProperties({ query: this.connectionQuery(), room });
    this.socket.reconnect();
    this.redirecting = false;

    this.notify();
  }

  // -- Public API ----------------------------------------------------------

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

  /** Get a readonly snapshot of the current state. */
  getSnapshot(): MultiplayerSnapshot {
    return {
      claims: this._claims,
      connectionStatus: this._connectionStatus,
      hostId: this._hostId,
      playerId: this._playerId,
      players: this._players,
      room: this._room,
      sharedState: this._sharedState,
    };
  }

  // -- Server time ---------------------------------------------------------

  /**
   * The room's shared clock — the server's, measured from here. Stamp updates
   * with `serverNow()` and pass this as an `Interpolator`'s `clock`: every
   * sender then shares one timebase, and it survives host migration.
   */
  get serverClock(): ServerClock {
    return this.clock;
  }

  /** Server time now (ms since the epoch); the local clock until the first probe returns. */
  serverNow(localNow?: number): number {
    return this.clock.now(localNow);
  }

  /** Fastest recent round trip to the server (ms); NaN until measured. */
  get rtt(): number {
    return this.clock.rtt;
  }

  // -- Claims --------------------------------------------------------------

  /** Who holds each claimed key (server-arbitrated). */
  get claims(): ClaimMap {
    return this._claims;
  }

  /** The player holding `key` now, or null (never claimed, released, or its TTL ran out). */
  ownerOf(key: string): string | null {
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
   * names someone else. `ttlMs` releases it automatically.
   */
  claim(key: string, options?: { ttlMs?: number }): void {
    const ttl = options?.ttlMs;
    this.flushCoalescedEvents();
    this.send({ data: ttl === undefined ? { key } : { key, ttl }, type: "claim" });
  }

  /** Give `key` back. Its owner may; the host may release any key. */
  release(key: string): void {
    this.flushCoalescedEvents();
    this.send({ data: { key }, type: "release" });
  }

  /** Host only: release every key starting with `prefix` ("" clears them all) — a new round. */
  clearClaims(prefix = ""): void {
    this.flushCoalescedEvents();
    this.send({ data: { prefix }, type: "clear_claims" });
  }

  // -- Ticks ---------------------------------------------------------------

  /** A tick room's clock, or null (no `tickRate`, or not yet synced). */
  get tickClock(): TickClock | null {
    const { ticks } = this;
    return ticks ? { epoch: ticks.epoch, ms: ticks.ms, n: ticks.n } : null;
  }

  /**
   * Tick rooms: every player's held input as of tick `at` (default: the last
   * tick received) — what a late joiner starts from, or replays a world
   * snapshot stamped with an earlier tick from. Null outside the history the
   * room keeps (MAX_TICK_HISTORY ticks) or outside a tick room.
   */
  tickInputs(at?: number): Record<string, JsonValue> | null {
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
  serverTick(localNow?: number): number {
    const { ticks } = this;
    return ticks ? Math.floor((this.serverNow(localNow) - ticks.epoch) / ticks.ms) : Number.NaN;
  }

  /**
   * Tick rooms: this player's input from tick `n` on (default: the server's
   * next tick; a past tick is moved to the next). It stays held until the next
   * `sendInput`, so send on change.
   */
  sendInput(input: JsonValue, n?: number): void {
    if (JSON.stringify(input).length > MAX_INPUT_BYTES) {
      console.warn(`Input over ${MAX_INPUT_BYTES} characters; the server would drop it.`);
      return;
    }
    this.heldInput = { value: input };
    this.flushCoalescedEvents();
    this.send({ data: n === undefined ? { v: input } : { n, v: input }, type: "input" });
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Update shared state (merged with current). Only changed keys ride the wire. */
  updateSharedState(updater: JsonRecord | StateUpdater): void {
    const prev = this._sharedState;
    const next = isUpdaterFn(updater) ? updater(prev) : { ...prev, ...updater };
    if (!this.passesSchema("sharedState", "outgoing", next)) {
      return;
    }
    this._sharedState = next;
    // Flush unconditionally — coalesced events must precede whatever state
    // message goes out next, even when this particular delta turns out empty.
    this.flushCoalescedEvents();
    // Every hop shallow-merges patches, so unchanged keys can stay local. For
    // the object form the game already named the keys it means to write; for
    // the function form, diff the returned state against the previous one.
    const delta = changedKeys(prev, isUpdaterFn(updater) ? next : updater);
    if (delta) {
      this.send({ data: delta, type: "state_patch" });
    }
    this.notify();
  }

  /** Update this player's state (merged with current). Only changed keys ride the wire. */
  updateMyState(updater: JsonRecord | StateUpdater): void {
    if (!this._playerId) {
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

    this.flushCoalescedEvents();
    const delta = changedKeys(current, isUpdaterFn(updater) ? next : updater);
    if (delta) {
      this.send({ data: delta, type: "player_state_patch" });
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
  sendEvent(event: string, payload: JsonValue, options?: SendEventOptions): void {
    const to = normalizeIds(options?.to);
    const except = normalizeIds(options?.except);
    if (options?.coalesce) {
      // Keyed by event + target signature: two "damage" events aimed at
      // different victims must not collapse into one (the survivor's payload
      // would reach the wrong audience).
      const key = `${event}\u0000${to?.join(",") ?? ""}\u0000${except?.join(",") ?? ""}`;
      this.pendingCoalesced.set(key, { event, except, payload, to });
      if (!this.coalesceFlushScheduled) {
        this.coalesceFlushScheduled = true;
        queueMicrotask(() => {
          this.coalesceFlushScheduled = false;
          this.flushCoalescedEvents();
        });
      }
      return;
    }
    this.flushCoalescedEvents();
    this.send({ data: emitData(event, payload, to, except), type: "emit" });
  }

  get onEvent(): MultiplayerOptions["onEvent"] {
    return this._onEvent;
  }

  /** Set the onEvent callback. */
  set onEvent(fn: MultiplayerOptions["onEvent"]) {
    this._onEvent = fn;
  }

  get onClaim(): MultiplayerOptions["onClaim"] {
    return this._onClaim;
  }

  /** Set the onClaim callback. */
  set onClaim(fn: MultiplayerOptions["onClaim"]) {
    this._onClaim = fn;
  }

  get onTick(): MultiplayerOptions["onTick"] {
    return this._onTick;
  }

  /** Set the onTick callback. */
  set onTick(fn: MultiplayerOptions["onTick"]) {
    this._onTick = fn;
  }

  /** Disconnect and clean up. */
  destroy(): void {
    this.flushCoalescedEvents();
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
    this.socket.removeEventListener("open", this.handleOpen);
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("close", this.handleClose);
    this.socket.removeEventListener("error", this.handleError);
    this.socket.close();
    this.listeners.clear();
  }

  // -- Internal ------------------------------------------------------------

  private send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  /** One server-clock probe; the answer comes back as a `time` message. */
  private probeTime(): void {
    if (this._connectionStatus === "connected") {
      this.send({ data: { c: performance.now() }, type: "time" });
    }
  }

  /** Send pending coalesced events now, latest payload per key, in first-queued order. */
  private flushCoalescedEvents(): void {
    if (this.pendingCoalesced.size === 0) {
      return;
    }
    for (const { event, payload, to, except } of this.pendingCoalesced.values()) {
      this.send({ data: emitData(event, payload, to, except), type: "emit" });
    }
    this.pendingCoalesced.clear();
  }

  /**
   * Run the registered schema (if any) for a channel against a candidate FULL
   * state. Returns whether the state may be used; a failure is reported via
   * `schemas.onViolation` (default: console.warn). Empty states bypass
   * validation — rooms and players start empty by protocol, before any seed
   * or first update arrives. Async schemas can't gate a synchronous game
   * loop, so they warn once and pass.
   */
  private passesSchema(
    channel: SchemaViolation["channel"],
    direction: SchemaViolation["direction"],
    state: JsonRecord,
    from?: string,
  ): boolean {
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

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private handleOpen = (): void => {
    // A live socket isn't admission: a full room replies `room_full` and
    // closes without ever sending `sync`. Stay "connecting" and withhold
    // playerId until `sync` confirms we're actually in the room.
    this._connectionStatus = "connecting";
    this.notify();
  };

  private handleClose = (): void => {
    // While redirecting to an overflow room, mask the interim close(s) — both
    // the synchronous one from reconnect() and the server's async close(4001)
    // — until `sync` admits us to the new room (which clears `redirecting`).
    if (this.redirecting) {
      return;
    }
    this._connectionStatus = "disconnected";
    this.notify();
  };

  private handleError = (): void => {
    // Not masked during redirect: redirecting is cleared synchronously after
    // reconnect(), so any error here is a genuine failure of the overflow
    // connection and should surface rather than hang at "connecting".
    this._connectionStatus = "error";
    this.notify();
  };

  /**
   * Seed `options.initialState` iff we are the host of a genuinely empty room.
   * Emptiness is judged by `remoteStateSeen` (the server's view), not the
   * locally pre-seeded `_sharedState`: a guest promoted mid-round has never
   * tripped `initialStateApplied`, and seeding then would wipe the live board
   * for everyone (issue #240). Called from both `sync` and `host` handlers.
   */
  private maybeSeedInitialState(hostId: string): void {
    if (
      hostId === this.socket.id &&
      this.options.initialState &&
      !this.initialStateApplied &&
      !this.remoteStateSeen
    ) {
      this.initialStateApplied = true;
      this.send({ data: this.options.initialState, type: "state_patch" });
    }
  }

  /**
   * `sync` is the admission signal: now we're really in the room, so surface
   * "connected" and adopt our playerId.
   */
  private applySync(data: Extract<ServerMessage, { type: "sync" }>["data"]): void {
    this._connectionStatus = "connected";
    this._playerId = this.socket.id ?? null;
    this._hostId = data.hostId;
    this._players = data.players;
    this._claims = data.claims;
    this.syncTicks(data.tick);
    // Measure the server clock straight away — games stamp with it from the
    // first frame — then settle into the heartbeat's slow cadence.
    for (const timer of this.probeTimers) {
      clearTimeout(timer);
    }
    this.probeTimers = TIME_PROBE_BURST_MS.map((delay) =>
      setTimeout(() => {
        this.probeTime();
      }, delay),
    );
    this.lastProbeAt = performance.now();
    // remoteStateSeen tracks the SERVER's view, so it is set even when
    // the local schema rejects the payload — the room has live state
    // either way, and a promoted host must never re-seed over it.
    if (Object.keys(data.state).length > 0) {
      this.remoteStateSeen = true;
    }
    const merged =
      Object.keys(this._sharedState).length === 0
        ? data.state
        : { ...this._sharedState, ...data.state };
    // On violation keep the previous local state — refusing admission
    // over bad room data would strand the player on "connecting".
    if (this.passesSchema("sharedState", "incoming", merged)) {
      this._sharedState = merged;
    }

    this.maybeSeedInitialState(data.hostId);

    // Every reconnect is a brand-new connection server-side, with an empty
    // player state — and `sync` is the one signal that fires on each of
    // them. Without re-announcing, our state would stay empty for everyone
    // else until the game happened to call updateMyState again.
    if (this._playerId && Object.keys(this._myState).length > 0) {
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
  }

  private applyClaim(key: string, owner: string | null, until?: number): void {
    if (owner === null) {
      const { [key]: _released, ...remaining } = this._claims;
      this._claims = remaining;
    } else {
      this._claims = { ...this._claims, [key]: until === undefined ? { owner } : { owner, until } };
    }
    this._onClaim?.(key, owner);
  }

  /**
   * Adopt a sync's tick clock. Back from a blip on the same tick timeline, the
   * ticks missed meanwhile replay through `onTick` in order — a lockstep sim
   * never skips one. Otherwise (first join, the room restarted, a gap past the
   * history) the timeline starts at the sync's tick: read `tickClock` and
   * `tickInputs()` to (re)start the sim.
   */
  private syncTicks(sync: TickSync | null): void {
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
    // The server cleared this player's input when the transport dropped.
    if (this.heldInput) {
      this.sendInput(this.heldInput.value);
    }
  }

  private applyTick(n: number, changed: Record<string, JsonValue>): void {
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
    this._onTick?.({ changed, inputs: Object.fromEntries(ticks.held), n });
  }

  private handleMessage = (event: MessageEvent): void => {
    try {
      // SAFETY: the party server is the only peer on this socket and speaks
      // exactly this protocol; unknown `type` values fall through the switch
      // untouched, and a malformed `data` throws inside this try and is logged.
      const message = JSON.parse(event.data) as ServerMessage;
      if (this.applyMessage(message)) {
        this.notify();
      }
    } catch (error) {
      console.error("Failed to process multiplayer message", error);
    }
  };

  /** Apply one server message; true when subscribers should hear about it. */
  private applyMessage(message: ServerMessage): boolean {
    switch (message.type) {
      case "ping": {
        // Answered from the message handler rather than a timer, so it keeps
        // working while the tab is hidden — that's what makes it a safe basis
        // for eviction. See EVICTION_TIMEOUT_MS.
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
        this.remoteStateSeen = true;
        const merged = { ...this._sharedState, ...message.data };
        if (this.passesSchema("sharedState", "incoming", merged)) {
          this._sharedState = merged;
        }
        return true;
      }
      case "player_state": {
        this.mergePlayerState(message.data.id, message.data.state);
        return true;
      }
      case "player_connection": {
        // Transport-drop / reconnect notice for a peer whose seat is held in
        // the grace window. The player is still in the room, so only flip the
        // flag — `player_left` is what actually removes them.
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
        // Clock samples change nothing a subscriber renders.
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
        // Ticks arrive tens of times a second and carry inputs, not
        // anything a subscriber renders: onTick is their channel.
        return false;
      }
      case "room_full": {
        // The room hit its cap before we joined. Reconnect to the overflow
        // sibling the server picked, carrying its authoritative capacity so
        // the shard keeps the same cap; redirectTo notifies on its own.
        this.redirectTo(message.data.room, message.data.capacity);
        return false;
      }
      default: {
        return true;
      }
    }
  }

  /**
   * Merge a player-state message: a keyed delta — or the whole state for a
   * player who just came back into interest range; shallow-merging handles
   * both, because keys are only ever merged, never deleted. The schema check
   * runs on the MERGED result, mirroring the sharedState path: a delta is
   * partial by design and would fail any schema with required fields.
   */
  private mergePlayerState(id: string, state: JsonRecord): void {
    const existing = this._players[id] ?? { id };
    const mergedState = { ...existing.state, ...state };
    if (!this.passesSchema("playerState", "incoming", mergedState, id)) {
      return;
    }
    this._players = { ...this._players, [id]: { ...existing, state: mergedState } };
  }

  /** Set presence flags on a player this client already knows. */
  private patchPlayer(id: string, flags: Pick<Player, "connected" | "visible">): void {
    const known = this._players[id];
    if (known) {
      this._players = { ...this._players, [id]: { ...known, ...flags } };
    }
  }

  private applyClaimsCleared(prefix: string): void {
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
