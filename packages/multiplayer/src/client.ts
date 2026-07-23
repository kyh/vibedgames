import PartySocket from "partysocket";

import type {
  ClientMessage,
  MultiplayerConnectionStatus,
  MultiplayerOptions,
  Player,
  PlayerMap,
  SendEventOptions,
  ServerMessage,
} from "./types.js";
import {
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_TOKEN_QUERY_PARAM,
  ROOM_CAP_QUERY_PARAM,
} from "./types.js";
import type { MultiplayerSchemas, SchemaViolation } from "./validation.js";

/** Accept a single id or a list; undefined stays undefined so the field can be
 *  omitted from the wire message entirely. */
const normalizeIds = (ids: string | string[] | undefined): string[] | undefined => {
  if (ids === undefined) return undefined;
  return Array.isArray(ids) ? ids : [ids];
};

/** A coalesced event waiting for the next microtask flush. */
type PendingEvent = {
  event: string;
  payload: unknown;
  to?: string[];
  except?: string[];
};

/** Emit-message data with targeting fields omitted (not undefined) when
 *  untargeted, so plain broadcasts stay byte-identical to the pre-targeting
 *  wire protocol. */
const emitData = (
  event: string,
  payload: unknown,
  to: string[] | undefined,
  except: string[] | undefined,
): { event: string; payload: unknown; to?: string[]; except?: string[] } => ({
  event,
  payload,
  ...(to ? { to } : {}),
  ...(except ? { except } : {}),
});

export type MultiplayerClientOptions = MultiplayerOptions & {
  /**
   * Shared state to seed the room with, applied exactly once per room by the
   * FIRST host of a still-empty room. It is never re-applied on host
   * promotion: when the host leaves mid-round and another client is promoted,
   * the room's live state wins — the new host must not reset it. Rooms that
   * already have shared state (observed via `sync` or any `state_patch`) are
   * never re-seeded.
   */
  initialState?: Record<string, unknown>;
  /**
   * Optional state schemas (Standard Schema — zod v3.24+, valibot, arktype…).
   * Outgoing updates that fail validation are blocked before send; incoming
   * ones are dropped before merge. See `MultiplayerSchemas` for semantics.
   */
  schemas?: MultiplayerSchemas;
};

export type MultiplayerSnapshot = {
  connectionStatus: MultiplayerConnectionStatus;
  playerId: string | null;
  hostId: string | null;
  sharedState: Record<string, unknown>;
  players: PlayerMap;
  /**
   * The room the client is actually connected to. Equals the configured
   * `room` until a cap is hit, then becomes the overflow sibling
   * (`{room}~2`, …) the server redirected this client into.
   */
  room: string;
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
  if (uuid) return uuid;
  return `t-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
};

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

  private _connectionStatus: MultiplayerConnectionStatus = "connecting";
  private _playerId: string | null = null;
  private _hostId: string | null = null;
  private _sharedState: Record<string, unknown>;
  private _players: PlayerMap = {};
  private _room: string;
  private _onEvent: MultiplayerOptions["onEvent"];
  /** Our own player state, held outside `_players` so it survives a reconnect
   *  (which replaces `_players` wholesale and hands us a new player id) and can
   *  be re-announced to the fresh server-side connection. */
  private _myState: Record<string, unknown> = {};

  constructor(options: MultiplayerClientOptions) {
    this.options = options;
    this._sharedState = options.initialState ?? {};
    this._onEvent = options.onEvent;
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
      room: options.room,
      query: this.connectionQuery(),
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
        if (this._connectionStatus === "connected") this.send({ type: "heartbeat" });
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
        if (this._connectionStatus === "connected") this.send({ type: "heartbeat" });
      }, HEARTBEAT_INTERVAL_MS);
    }
  }

  /** Query params sent on every (re)connect: effective cap + reconnect token. */
  private connectionQuery(): Record<string, string> {
    const query: Record<string, string> = {
      [RECONNECT_TOKEN_QUERY_PARAM]: this.reconnectToken,
    };
    if (this.cap !== null) query[ROOM_CAP_QUERY_PARAM] = String(this.cap);
    return query;
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
    // Queued for a room that never admitted us — don't leak them into the new one.
    this.pendingCoalesced.clear();

    // Mask only the one synchronous close that reconnect() dispatches for the
    // old connection. The server's async close(4001) never reaches
    // handleClose — reconnect()'s internal disconnect removes the old socket's
    // listeners first — so clearing synchronously is safe and lets genuine
    // overflow-connection failures still surface as error/disconnected.
    this.redirecting = true;
    this.socket.updateProperties({ room, query: this.connectionQuery() });
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
      connectionStatus: this._connectionStatus,
      playerId: this._playerId,
      hostId: this._hostId,
      sharedState: this._sharedState,
      players: this._players,
      room: this._room,
    };
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Update shared state (merged with current). */
  updateSharedState(
    updater: Record<string, unknown> | ((prev: Record<string, unknown>) => Record<string, unknown>),
  ): void {
    const next =
      typeof updater === "function"
        ? updater(this._sharedState)
        : { ...this._sharedState, ...updater };
    if (!this.passesSchema("sharedState", "outgoing", next)) return;
    this._sharedState = next;
    this.flushCoalescedEvents();
    this.send({ type: "state_patch", data: next });
    this.notify();
  }

  /** Update this player's state (merged with current). */
  updateMyState(
    updater: Record<string, unknown> | ((prev: Record<string, unknown>) => Record<string, unknown>),
  ): void {
    if (!this._playerId) return;
    const current = (this._players[this._playerId]?.state as Record<string, unknown>) ?? {};
    const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
    if (!this.passesSchema("playerState", "outgoing", next)) return;

    const existing = this._players[this._playerId] ?? { id: this._playerId };
    this._players = {
      ...this._players,
      [this._playerId]: { ...existing, state: next },
    };
    this._myState = next;

    this.flushCoalescedEvents();
    this.send({ type: "player_state_patch", data: next });
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
  sendEvent(event: string, payload: unknown, options?: SendEventOptions): void {
    const to = normalizeIds(options?.to);
    const except = normalizeIds(options?.except);
    if (options?.coalesce) {
      // Keyed by event + target signature: two "damage" events aimed at
      // different victims must not collapse into one (the survivor's payload
      // would reach the wrong audience).
      const key = `${event}\u0000${to?.join(",") ?? ""}\u0000${except?.join(",") ?? ""}`;
      this.pendingCoalesced.set(key, { event, payload, to, except });
      if (!this.coalesceFlushScheduled) {
        this.coalesceFlushScheduled = true;
        Promise.resolve().then(() => {
          this.coalesceFlushScheduled = false;
          this.flushCoalescedEvents();
        });
      }
      return;
    }
    this.flushCoalescedEvents();
    this.send({ type: "emit", data: emitData(event, payload, to, except) });
  }

  /** Set the onEvent callback. */
  set onEvent(fn: MultiplayerOptions["onEvent"]) {
    this._onEvent = fn;
  }

  /** Disconnect and clean up. */
  destroy(): void {
    this.flushCoalescedEvents();
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

  /** Send pending coalesced events now, latest payload per key, in first-queued order. */
  private flushCoalescedEvents(): void {
    if (this.pendingCoalesced.size === 0) return;
    for (const { event, payload, to, except } of this.pendingCoalesced.values()) {
      this.send({ type: "emit", data: emitData(event, payload, to, except) });
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
    state: Record<string, unknown>,
    from?: string,
  ): boolean {
    const schemas = this.options.schemas;
    const schema = channel === "sharedState" ? schemas?.sharedState : schemas?.playerState;
    if (!schema) return true;
    if (Object.keys(state).length === 0) return true;

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
    if (!result.issues) return true;

    const violation: SchemaViolation = {
      channel,
      direction,
      issues: result.issues,
      data: state,
      ...(from !== undefined ? { from } : {}),
    };
    if (schemas?.onViolation) {
      schemas.onViolation(violation);
    } else {
      console.warn(`[multiplayer] ${direction} ${channel} failed schema validation`, result.issues);
    }
    return false;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
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
    if (this.redirecting) return;
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
      this.send({ type: "state_patch", data: this.options.initialState });
    }
  }

  private handleMessage = (event: MessageEvent): void => {
    try {
      const message = JSON.parse(event.data) as ServerMessage;

      switch (message.type) {
        case "ping": {
          // Answered from the message handler rather than a timer, so it keeps
          // working while the tab is hidden — that's what makes it a safe basis
          // for eviction. See EVICTION_TIMEOUT_MS.
          this.send({ type: "pong" });
          break;
        }
        case "sync": {
          // `sync` is the admission signal: now we're really in the room, so
          // surface "connected" and adopt our playerId.
          this._connectionStatus = "connected";
          this._playerId = this.socket.id ?? null;
          this._hostId = message.data.hostId;
          this._players = message.data.players;
          // remoteStateSeen tracks the SERVER's view, so it is set even when
          // the local schema rejects the payload — the room has live state
          // either way, and a promoted host must never re-seed over it.
          if (Object.keys(message.data.state).length > 0) this.remoteStateSeen = true;
          {
            const merged =
              Object.keys(this._sharedState).length === 0
                ? message.data.state
                : { ...this._sharedState, ...message.data.state };
            // On violation keep the previous local state — refusing admission
            // over bad room data would strand the player on "connecting".
            if (this.passesSchema("sharedState", "incoming", merged)) {
              this._sharedState = merged;
            }
          }

          this.maybeSeedInitialState(message.data.hostId);

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
            this.send({ type: "player_state_patch", data: this._myState });
          }
          break;
        }
        case "player_joined": {
          this._players = { ...this._players, [message.data.id]: message.data as Player };
          break;
        }
        case "player_left": {
          const updated = { ...this._players };
          delete updated[message.data.id];
          this._players = updated;
          break;
        }
        case "host": {
          this._hostId = message.data.id;
          this.maybeSeedInitialState(message.data.id);
          break;
        }
        case "state_patch": {
          this.remoteStateSeen = true;
          const merged = { ...this._sharedState, ...message.data };
          if (!this.passesSchema("sharedState", "incoming", merged)) break;
          this._sharedState = merged;
          break;
        }
        case "player_state": {
          if (!this.passesSchema("playerState", "incoming", message.data.state, message.data.id)) {
            break;
          }
          const existing = this._players[message.data.id] ?? { id: message.data.id };
          this._players = {
            ...this._players,
            [message.data.id]: { ...existing, state: message.data.state },
          };
          break;
        }
        case "player_connection": {
          // Transport-drop / reconnect notice for a peer whose seat is held in
          // the grace window. The player is still in the room, so only flip the
          // flag — `player_left` is what actually removes them.
          const holder = this._players[message.data.id];
          if (!holder) break;
          this._players = {
            ...this._players,
            [message.data.id]: { ...holder, connected: message.data.connected },
          };
          break;
        }
        case "event": {
          this._onEvent?.(message.data.event, message.data.payload, message.data.from);
          break;
        }
        case "room_full": {
          // The room hit its cap before we joined. Reconnect to the overflow
          // sibling the server picked, carrying its authoritative capacity so
          // the shard keeps the same cap; redirectTo notifies on its own.
          this.redirectTo(message.data.room, message.data.capacity);
          return;
        }
      }

      this.notify();
    } catch (error) {
      console.error("Failed to process multiplayer message", error);
    }
  };
}
