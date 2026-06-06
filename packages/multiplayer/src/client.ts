import PartySocket from "partysocket";

import type {
  ClientMessage,
  MultiplayerConnectionStatus,
  MultiplayerOptions,
  Player,
  PlayerMap,
  ServerMessage,
} from "./types";
import { ROOM_CAP_QUERY_PARAM } from "./types";

export type MultiplayerClientOptions = MultiplayerOptions & {
  initialState?: Record<string, unknown>;
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
  private options: MultiplayerClientOptions;
  /** True while we reconnect to an overflow room, to mask the interim close. */
  private redirecting = false;

  private _connectionStatus: MultiplayerConnectionStatus = "connecting";
  private _playerId: string | null = null;
  private _hostId: string | null = null;
  private _sharedState: Record<string, unknown>;
  private _players: PlayerMap = {};
  private _room: string;
  private _onEvent: MultiplayerOptions["onEvent"];

  constructor(options: MultiplayerClientOptions) {
    this.options = options;
    this._sharedState = options.initialState ?? {};
    this._onEvent = options.onEvent;
    this._room = options.room;

    const query: Record<string, string> = {};
    if (options.maxPlayers && options.maxPlayers > 0) {
      query[ROOM_CAP_QUERY_PARAM] = String(Math.floor(options.maxPlayers));
    }

    this.socket = new PartySocket({
      host: options.host,
      party: options.party,
      room: options.room,
      query,
    });

    // Listeners are registered once and survive PartySocket's reconnects,
    // including the room switch we trigger on overflow (updateProperties +
    // reconnect). No need to re-attach them per connection.
    this.socket.addEventListener("open", this.handleOpen);
    this.socket.addEventListener("message", this.handleMessage);
    this.socket.addEventListener("close", this.handleClose);
    this.socket.addEventListener("error", this.handleError);
  }

  /**
   * Move to an overflow room after the current room reported it was full.
   * Uses PartySocket's own `updateProperties` + `reconnect` so the rebuilt
   * URL points at the overflow room before reconnecting — the library's
   * reconnect then naturally targets the new room (no risk of looping back
   * into the full one). The full room never admitted us, so reset to the
   * caller-provided defaults; a fresh room must not inherit optimistic writes
   * made before the redirect, and we re-seed as host if we land there first.
   */
  private redirectTo(room: string): void {
    this._room = room;
    this._connectionStatus = "connecting";
    this.initialStateApplied = false;
    this._players = {};
    this._hostId = null;
    this._playerId = null;
    this._sharedState = this.options.initialState ?? {};

    // Stay in the redirecting state until the overflow socket opens, so every
    // interim close (the synchronous reconnect() one and the server's async
    // close(4001)) is masked. handleOpen clears the flag.
    this.redirecting = true;
    this.socket.updateProperties({ room });
    this.socket.reconnect();

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
    this._sharedState = next;
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

    const existing = this._players[this._playerId] ?? { id: this._playerId };
    this._players = {
      ...this._players,
      [this._playerId]: { ...existing, state: next },
    };

    this.send({ type: "player_state_patch", data: next });
    this.notify();
  }

  /** Send a custom event to all players. */
  sendEvent(event: string, payload: unknown): void {
    this.send({ type: "emit", data: { event, payload } });
  }

  /** Set the onEvent callback. */
  set onEvent(fn: MultiplayerOptions["onEvent"]) {
    this._onEvent = fn;
  }

  /** Disconnect and clean up. */
  destroy(): void {
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
    // Masked during a redirect, like close: a transient failure on the
    // overflow reconnect shouldn't surface "error" — RWS retries and
    // admission completes on the next `sync`.
    if (this.redirecting) return;
    this._connectionStatus = "error";
    this.notify();
  };

  private handleMessage = (event: MessageEvent): void => {
    try {
      const message = JSON.parse(event.data) as ServerMessage;

      switch (message.type) {
        case "sync": {
          // `sync` is the admission signal: now we're really in the room, so
          // surface "connected", adopt our playerId, and end any redirect.
          this.redirecting = false;
          this._connectionStatus = "connected";
          this._playerId = this.socket.id ?? null;
          this._hostId = message.data.hostId;
          this._players = message.data.players;
          this._sharedState =
            Object.keys(this._sharedState).length === 0
              ? message.data.state
              : { ...this._sharedState, ...message.data.state };

          if (
            message.data.hostId === this.socket.id &&
            !this.initialStateApplied &&
            this.options.initialState
          ) {
            this.initialStateApplied = true;
            this.send({ type: "state_patch", data: this.options.initialState });
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
          if (
            message.data.id === this.socket.id &&
            this.options.initialState &&
            !this.initialStateApplied
          ) {
            this.initialStateApplied = true;
            this.send({ type: "state_patch", data: this.options.initialState });
          }
          break;
        }
        case "state_patch": {
          this._sharedState = { ...this._sharedState, ...message.data };
          break;
        }
        case "player_state": {
          const existing = this._players[message.data.id] ?? { id: message.data.id };
          this._players = {
            ...this._players,
            [message.data.id]: { ...existing, state: message.data.state },
          };
          break;
        }
        case "event": {
          this._onEvent?.(message.data.event, message.data.payload, message.data.from);
          break;
        }
        case "room_full": {
          // The room hit its cap before we joined. Reconnect to the overflow
          // sibling the server picked; redirectTo notifies on its own.
          this.redirectTo(message.data.room);
          return;
        }
      }

      this.notify();
    } catch (error) {
      console.error("Failed to process multiplayer message", error);
    }
  };
}
