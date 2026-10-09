import { PartySocket } from "partysocket";

import { trackClient } from "./net-stats.js";
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
  OFFLINE_PLAYER_ID,
  RECONNECT_TOKEN_QUERY_PARAM,
  RESERVED_CLAIM_KEYS,
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
/** Probe cadence until the clock has a full window: a boot stall can spoil the burst. */
const TIME_PROBE_SETTLE_MS = 500;
/** `fallbackMs` counts a frame for at most this long (ms): a hidden tab or a
 *  stalled main thread renders nothing, and its gap is not time the client
 *  spent unable to reach a room. */
const FALLBACK_FRAME_MS = 100;

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
  /** The room's socket; null offline, and once destroyed. */
  private socket: PartySocket | null = null;
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
  /** True once any room has admitted this client: from then on it is
   *  reconnecting, never connecting, and never falls back. */
  private admitted = false;
  /** `fallbackMs`: rendered time spent unadmitted, and the last frame's time. */
  private fallbackElapsed = 0;
  private lastFrameAt: number | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Offline claims with a TTL, each lapsing on its own timer. */
  private readonly claimTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
  /** The last `getSnapshot()`, handed out again while nothing in it changed. */
  private snapshot: MultiplayerSnapshot | null = null;
  /** Takes this client off `__VG_NET__.clients()` (see net-stats.ts). */
  private readonly untrack: () => void;
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

    if (options.offline) {
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

  /** Open the room's socket. Its listeners are registered once and survive
   *  PartySocket's reconnects, including the room switch an overflow makes
   *  (updateProperties + reconnect). */
  private dial(): PartySocket {
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

  /** Close the room's socket for good: a deliberate leave, which the server
   *  answers by freeing the seat at once. */
  private hangUp(): void {
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

  /** Drive the heartbeat off rAF so a hidden/asleep tab stops pinging (its rAF is
   *  paused), and the server promptly migrates host away from it. The same
   *  frames count down `fallbackMs`. */
  private startHeartbeat(): void {
    const ping = (t: number): void => {
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
      // With no frames to count, the deadline runs on wall time.
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

  /** `fallbackMs`: go offline once that much rendered time has passed, from
   *  the first frame, without any room admitting this client. */
  private checkFallback(t: number): void {
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

  /** Stop the heartbeat, the time probes and the fallback deadline. */
  private stopTimers(): void {
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

  /** This client as a room of one: the only player, and the host. */
  private enterOffline(): void {
    this._connectionStatus = "offline";
    this._playerId = OFFLINE_PLAYER_ID;
    this._hostId = OFFLINE_PLAYER_ID;
    this._players = {
      [OFFLINE_PLAYER_ID]: { connected: true, id: OFFLINE_PLAYER_ID, state: this._myState },
    };
    this.ticks = null;
    this.clock.adoptLocal();
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
   * there first. A client a room admitted before (back from a drop whose
   * seat lapsed, into a room that filled meanwhile) is still reconnecting,
   * not connecting, and never falls back.
   */
  private redirectTo(room: string, capacity: number): void {
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
    this.ticks = null;
    this.heldInput = null;
    // Queued for a room that never admitted us — don't leak them into the new one.
    this.pendingCoalesced.clear();

    // The close reconnect() dispatches for the old connection reads the same.
    this.socket?.updateProperties({ query: this.connectionQuery(), room });
    this.socket?.reconnect();

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

  /**
   * A readonly snapshot of the current state: the same object until something
   * in it changes. `useSyncExternalStore` requires that — a fresh object on
   * every read looks like a change on every render, and React re-renders
   * until it gives up.
   */
  getSnapshot(): MultiplayerSnapshot {
    const last = this.snapshot;
    if (
      last !== null &&
      last.claims === this._claims &&
      last.connectionStatus === this._connectionStatus &&
      last.hostId === this._hostId &&
      last.playerId === this._playerId &&
      last.players === this._players &&
      last.room === this._room &&
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
      sharedState: this._sharedState,
    };
    return this.snapshot;
  }

  // -- Server time ---------------------------------------------------------

  /**
   * The room's shared clock — the server's, measured from here. Stamp updates,
   * deadlines and tick schedules with `serverNow()`: every client reads a stamp
   * as the same instant, and it survives host migration. Render remotes on a
   * per-sender `RemoteClock` instead (an Interpolator's default): a stamp
   * reaches you a whole relay after it was taken.
   */
  get serverClock(): ServerClock {
    return this.clock;
  }

  /**
   * Server time now (ms since the epoch). Until the first probe returns, and
   * offline if none ever did, it reads the local clock (`performance.now()`,
   * ms since the page loaded): don't stamp shared state with it then, or mix
   * it with `Date.now()`.
   */
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
   * names someone else. `ttlMs` (positive) releases it automatically.
   * Offline, nobody races: the claim is granted before this returns.
   */
  claim(key: string, options?: { ttlMs?: number }): void {
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
    this.flushCoalescedEvents();
    this.send({ data: ttl === undefined ? { key } : { key, ttl }, type: "claim" });
  }

  /** Give `key` back. Its owner may; the host may release any key. */
  release(key: string): void {
    if (this._connectionStatus === "offline") {
      this.clearClaimTimer(key);
      if (key in this._claims) {
        this.applyClaim(key, null);
        this.notify();
      }
      return;
    }
    this.flushCoalescedEvents();
    this.send({ data: { key }, type: "release" });
  }

  /** Host only: release every key starting with `prefix` ("" clears them all) — a new round. */
  clearClaims(prefix = ""): void {
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
    this.flushCoalescedEvents();
    this.send({ data: { prefix }, type: "clear_claims" });
  }

  /** Offline: stop `key`'s TTL timer, if it has one. */
  private clearClaimTimer(key: string): void {
    const timer = this.claimTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.claimTimers.delete(key);
    }
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
   * `sendInput`, so send on change. While the connection is down it is only
   * held, and the reconnect sends it.
   */
  sendInput(input: JsonValue, n?: number): void {
    if (JSON.stringify(input).length > MAX_INPUT_BYTES) {
      console.warn(`Input over ${MAX_INPUT_BYTES} characters; the server would drop it.`);
      return;
    }
    this.heldInput = { value: input };
    this.flushCoalescedEvents();
    if (!this.dropped) {
      this.send({ data: n === undefined ? { v: input } : { n, v: input }, type: "input" });
    }
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Update shared state (merged with current). Only changed keys ride the
   * wire, and nothing while the connection is down: a host's reconnect
   * re-sends whatever the server holds differently.
   */
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
    if (delta && !this.dropped) {
      this.send({ data: delta, type: "state_patch" });
    }
    this.notify();
  }

  /**
   * Update this player's state (merged with current). Only changed keys ride
   * the wire, and nothing while the connection is down: the reconnect
   * re-sends the whole state.
   */
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
    if (delta && !this.dropped) {
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
    if (this._connectionStatus === "offline") {
      // The room is this client: an event it is in the audience of arrives at once.
      if (
        (to === undefined || to.includes(OFFLINE_PLAYER_ID)) &&
        !except?.includes(OFFLINE_PLAYER_ID)
      ) {
        this._onEvent?.(event, payload, OFFLINE_PLAYER_ID);
      }
      return;
    }
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

  /**
   * An intent for the host alone. The host — an offline client too — hands it
   * to its own `onEvent` at once instead of bouncing it off the server; a
   * guest sends it to the host. Dropped while no host is known.
   */
  sendToHost(event: string, payload: JsonValue): void {
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
  goOffline(): void {
    if (this._connectionStatus === "offline") {
      return;
    }
    this.hangUp();
    this.stopTimers();
    // Queued for the room just left.
    this.pendingCoalesced.clear();
    const claimsBefore = this._claims;
    this._claims = {};
    this.enterOffline();
    this.reportClaimChanges(claimsBefore);
    this.notify();
  }

  /** Disconnect and clean up. */
  destroy(): void {
    this.untrack();
    this.flushCoalescedEvents();
    this.stopTimers();
    for (const timer of this.claimTimers.values()) {
      clearTimeout(timer);
    }
    this.claimTimers.clear();
    this.hangUp();
    this.listeners.clear();
  }

  // -- Internal ------------------------------------------------------------

  /** Offline, and once destroyed, there is no socket: nothing is sent. */
  private send(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  /**
   * Reconnecting: admitted before, but out of the room now — the transport
   * dropped, or it is back and `sync` has not readmitted us yet. State patches
   * and inputs are streams, and PartySocket would queue every frame of them to
   * replay on reconnect, each to every peer (a 20 Hz stream queues 600 in a
   * 30 s drop). So they are not sent meanwhile: `sync` sends the latest — this
   * player's state, a host's world, the held input. Events and claims still
   * queue, as nothing re-sends those.
   */
  private get dropped(): boolean {
    return this._connectionStatus === "reconnecting";
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

  /**
   * The socket opened, closed or failed. None of these is admission — a full
   * room replies `room_full` and closes without ever sending `sync` — and
   * PartySocket redials by itself after a close, so until `sync` this client
   * is connecting, or reconnecting if a room has admitted it before. The
   * player id is withheld until `sync` confirms we're actually in the room.
   */
  private handleTransport = (): void => {
    this._connectionStatus = this.admitted ? "reconnecting" : "connecting";
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
      hostId === this.socket?.id &&
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
    const wasHost = this._hostId !== null && this._hostId === this._playerId;
    this._connectionStatus = "connected";
    this.admitted = true;
    this._playerId = this.socket?.id ?? null;
    this._hostId = data.hostId;
    this._players = data.players;
    const claimsBefore = this._claims;
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
    if (wasHost && data.hostId === this._playerId) {
      this.reassertWorld(data.state);
    } else {
      const merged =
        Object.keys(this._sharedState).length === 0
          ? data.state
          : { ...this._sharedState, ...data.state };
      // On violation keep the previous local state — refusing admission
      // over bad room data would strand the player on "connecting".
      if (this.passesSchema("sharedState", "incoming", merged)) {
        this._sharedState = merged;
      }
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

    this.reportClaimChanges(claimsBefore);
  }

  /**
   * Tell `onClaim` about every key whose owner a sync changed: on joining,
   * every live claim; back from a drop, whatever moved while this client was
   * away. A game then applies claims from one callback.
   */
  private reportClaimChanges(before: ClaimMap): void {
    const after = this._claims;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const owner = after[key]?.owner ?? null;
      if ((before[key]?.owner ?? null) !== owner) {
        this._onClaim?.(key, owner);
      }
    }
  }

  /**
   * A host back from a dropped transport kept running its world, while the
   * server's copy may be older — a restart restores it up to a second back,
   * and an oversized world not at all. The room still names us host, so our
   * world wins: re-send every key the server holds differently.
   */
  private reassertWorld(server: JsonRecord): void {
    const differs: JsonRecord = {};
    for (const [key, value] of Object.entries(this._sharedState)) {
      if (JSON.stringify(server[key]) !== JSON.stringify(value)) {
        differs[key] = value;
      }
    }
    this._sharedState = { ...server, ...this._sharedState };
    if (Object.keys(differs).length > 0) {
      this.send({ data: differs, type: "state_patch" });
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
    // Quiet ticks log nothing; the history ends here all the same.
    ticks.base = Math.max(ticks.base, n - MAX_TICK_HISTORY);
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
