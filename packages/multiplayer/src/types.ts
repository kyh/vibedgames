/** A JSON-parseable wire value — everything a multiplayer message can carry. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object map — the shape of shared/player state and their patches. */
export interface JsonRecord {
  [key: string]: JsonValue;
}

export interface MultiplayerOptions {
  host: string;
  party: string;
  room: string;
  /**
   * Maximum number of players allowed in a single room instance. When a room
   * is at capacity, additional players overflow into a sibling room
   * (`{room}~2`, `{room}~3`, …) automatically — the SDK transparently
   * reconnects the overflowing client to the next room. Omit for no cap
   * (unlimited, the historical behaviour). The server clamps this to a hard
   * ceiling regardless of what the client requests.
   */
  maxPlayers?: number;
  /**
   * Run the room on a server tick (Hz, clamped to 1–MAX_TICK_RATE): the server
   * stamps every `sendInput` into a numbered tick and broadcasts each tick's
   * input changes to everyone, in order — all a deterministic lockstep or
   * rollback game needs from a server. Omit for no tick.
   */
  tickRate?: number;
  /**
   * Interest management: players farther apart than `radius` (in the units of
   * the player-state keys `x`/`y`, default "x"/"y") stop receiving each
   * other's player state; such a player reads `visible: false`. The host always
   * receives everyone. Omit for no filtering.
   */
  interest?: InterestRule;
  /**
   * Bounds the server enforces on numeric player-state keys: a patch setting a
   * listed key outside its range is dropped before anyone sees it.
   */
  limits?: Record<string, PlayerLimit>;
  onEvent?: (event: string, payload: JsonValue, from: string) => void;
  /**
   * A claim's owner was set — granted (`owner` is the claimer), released
   * (`owner` null), or the server's answer to your own refused claim (`owner`
   * is whoever already holds it). A sync reports every key whose owner it
   * changed: all live claims on joining, whatever moved during a drop on
   * reconnecting. See `MultiplayerClient.claim`.
   */
  onClaim?: (key: string, owner: string | null) => void;
  /** A server tick (tick rooms only). See `TickInfo`. */
  onTick?: (tick: TickInfo) => void;
}

/** The interest rule a room filters player state by. */
export interface InterestRule {
  radius: number;
  x?: string;
  y?: string;
}

/** Inclusive bounds for one numeric player-state key. */
export interface PlayerLimit {
  min?: number;
  max?: number;
}

/**
 * The rules a room runs by. A room adopts them from its first admitted client
 * and keeps them until it empties, so every client should pass the same ones
 * (ship them in shared config, like `maxPlayers`).
 */
export interface RoomRules {
  tickRate?: number;
  interest?: InterestRule;
  limits?: Record<string, PlayerLimit>;
}

/** Who holds each claimed key, and until when (server time, ms) for a claim with a TTL. */
export interface ClaimInfo {
  owner: string;
  until?: number;
}

export type ClaimMap = Record<string, ClaimInfo>;

/** One server tick, as `onTick` receives it. */
export interface TickInfo {
  /** Tick number; ticks arrive in order with no gaps. */
  n: number;
  /** Every player's held input as of this tick (the last one each sent). */
  inputs: Record<string, JsonValue>;
  /** Just the players whose input changed on this tick (null = cleared: the player left). */
  changed: Record<string, JsonValue>;
}

/**
 * Wire form of a room's tick clock, sent in `sync`: the clock, plus the
 * recent input history — every held input as of tick `base` and each change
 * since — so a client can replay ticks it missed or start from any of them.
 */
export interface TickSync {
  /** Server time (ms) of tick 0. */
  epoch: number;
  /** Tick length (ms). */
  ms: number;
  /** The last tick broadcast. */
  n: number;
  /** The tick the history starts at. */
  base: number;
  /** Every player's held input as of tick `base`. */
  held: Record<string, JsonValue>;
  /** Each tick after `base` whose inputs changed, oldest first, with its changes. */
  log: [number, Record<string, JsonValue>][];
}

/** Highest tick rate a room may run at. */
export const MAX_TICK_RATE = 60;
/** Ticks of input history a room keeps (and sends in `sync`) for replay. */
export const MAX_TICK_HISTORY = 600;
/** How far ahead of the server's next tick an input may be scheduled. */
export const MAX_INPUT_LEAD_TICKS = 32;
/** Largest input (JSON characters): inputs are held and re-sent in every sync, so keep them to a few fields. */
export const MAX_INPUT_BYTES = 1024;
/** Claims a room holds at most; past it new keys are refused. */
export const MAX_CLAIMS = 10_000;
/** Longest claim key (characters). */
export const MAX_CLAIM_KEY_LENGTH = 128;
/** Longest claim time-to-live (ms). */
export const MAX_CLAIM_TTL_MS = 3_600_000;
/** Keys no claim may use: a plain-object claim map can't hold them as its own entries. */
export const RESERVED_CLAIM_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];
/** How often the SDK re-measures the server clock (ms). */
export const TIME_PROBE_INTERVAL_MS = 5000;

/**
 * Query-string key carrying the room rules (`RoomRules` as JSON). A room
 * adopts the first admitted client's rules and keeps them until it empties.
 */
export const ROOM_RULES_QUERY_PARAM = "_room";

/**
 * Query-string key the SDK uses to advertise a room's player cap to the
 * PartyServer on connect. Shared so the server reads the same key the client
 * writes — do not hardcode this string in either place.
 */
export const ROOM_CAP_QUERY_PARAM = "_maxPlayers";

/**
 * Query-string key carrying the client's reconnection token. The token is a
 * secret generated once per client instance and never broadcast to peers —
 * unlike the connection id, which every player in the room can see. Presenting
 * the same token within the grace window reclaims the seat (and its state)
 * held after a transport drop, so a network blip is a "reconnecting…" pause
 * instead of a leave + rejoin that wipes per-player state.
 */
export const RECONNECT_TOKEN_QUERY_PARAM = "_reconnectToken";

/**
 * How long the server holds a dropped player's seat (identity, per-player
 * state, room-cap slot) waiting for the same reconnection token to return
 * (ms). Peers see the player with `connected: false` during the window; only
 * after it lapses does the player actually leave the room.
 */
export const RECONNECT_GRACE_MS = 30_000;

export type MultiplayerConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export type PlayerState<T = JsonRecord> = T;

export interface Player {
  id: string;
  color?: string;
  hue?: string;
  state?: PlayerState;
  /**
   * False while the player's transport is down but their seat is being held
   * for a reconnect (see RECONNECT_GRACE_MS) — render a "reconnecting…"
   * treatment instead of removing them.
   */
  connected?: boolean;
  /**
   * False while the player is outside this client's interest radius (see
   * `MultiplayerOptions.interest`): their `state` is the last seen and no
   * longer updates — hide them. Absent means visible.
   */
  visible?: boolean;
}

export type PlayerMap = Record<string, Player>;

/**
 * Options for `MultiplayerClient.sendEvent`. Omit for the default: an
 * immediate broadcast to every player in the room (including the sender).
 *
 * - `to`: deliver only to these player ids. The sender is included only if its
 *   own id is listed.
 * - `except`: exclude these player ids (applied after `to`, if both given).
 * - `coalesce`: collapse rapid events sharing an event type AND target into a
 *   single wire message carrying the latest payload, flushed on the next
 *   microtask. Ordering is preserved: pending coalesced events are flushed
 *   before any outgoing state patch or non-coalesced event, so a coalesced
 *   event never overtakes — nor lags behind — a state update sent around it.
 *   Use for high-frequency annotations (damage numbers, cursor pings) where
 *   only the latest value matters.
 *
 * Targeting is enforced by the party server; coalescing is client-side.
 */
export interface SendEventOptions {
  to?: string | string[];
  except?: string | string[];
  coalesce?: boolean;
}

export type ClientMessage =
  | { type: "state_patch"; data: JsonRecord }
  | { type: "player_state_patch"; data: JsonRecord }
  | { type: "emit"; data: { event: string; payload: JsonValue; to?: string[]; except?: string[] } }
  // Liveness ping sent on an interval so the server can detect a host that has
  // gone away ungracefully (laptop sleep, crashed tab, dropped network) without
  // waiting for the WebSocket's much-longer TCP timeout, and migrate host.
  | { type: "heartbeat" }
  // Reply to the server's `ping`. Distinct from `heartbeat` on purpose — see
  // the note on EVICTION_TIMEOUT_MS below.
  | { type: "pong" }
  // Server-clock probe: `c` is the client's clock at send, echoed back.
  | { type: "time"; data: { c: number } }
  // Ask for a key; `ttl` (ms) releases it automatically.
  | { type: "claim"; data: { key: string; ttl?: number } }
  // Give a key back (its owner, or the host for any key).
  | { type: "release"; data: { key: string } }
  // Host only: release every key starting with `prefix` ("" = all).
  | { type: "clear_claims"; data: { prefix: string } }
  // Tick rooms: this player's input from tick `n` on (default: the next tick).
  | { type: "input"; data: { v: JsonValue; n?: number } };

/** How often the SDK sends a heartbeat (ms). */
export const HEARTBEAT_INTERVAL_MS = 2000;
/** Server migrates host if it hasn't heard from the host within this window (ms). */
export const HOST_LIVENESS_TIMEOUT_MS = 6000;

/**
 * `heartbeat` and `pong` answer two different questions, which is why both exist.
 *
 * `heartbeat` is rAF-driven, so it stops the moment a tab is hidden. That is
 * deliberate: a backgrounded host has a stalled game loop and should lose the
 * host role within HOST_LIVENESS_TIMEOUT_MS. But "hidden" is not "gone", so that
 * same silence must never be grounds for removing the player from the room.
 *
 * Eviction therefore needs a signal that survives a hidden tab. WebSocket
 * `message` events still fire when a tab is backgrounded (unlike rAF, and unlike
 * timers, which browsers throttle hard), so the server pings and the client
 * pongs from its message handler. A peer that stops answering that is genuinely
 * unreachable, not merely in another tab.
 */
export const PING_INTERVAL_MS = 30_000;
/** Server evicts a connection it has not heard *anything* from within this window (ms). */
export const EVICTION_TIMEOUT_MS = 75_000;

export type ServerMessage =
  | {
      type: "sync";
      data: {
        players: PlayerMap;
        state: JsonRecord;
        hostId: string;
        claims: ClaimMap;
        tick: TickSync | null;
        /** Server time (ms) when the sync was sent. */
        time: number;
      };
    }
  | { type: "player_joined"; data: Player }
  | { type: "player_left"; data: { id: string } }
  | { type: "host"; data: { id: string } }
  | { type: "state_patch"; data: JsonRecord }
  // A keyed delta of the player's state — or the whole state when the player
  // has just come back into this client's interest radius.
  | { type: "player_state"; data: { id: string; state: JsonRecord } }
  // A player's transport dropped (connected: false — seat held for the grace
  // window) or came back (connected: true).
  | { type: "player_connection"; data: { id: string; connected: boolean } }
  // A player left (visible: false) or entered (true) this client's interest radius.
  | { type: "player_visibility"; data: { id: string; visible: boolean } }
  | { type: "event"; data: { event: string; payload: JsonValue; from: string } }
  // Sent (then the socket is closed) when a player connects to a room that is
  // already at capacity. `room` is the sibling room the client should retry.
  | { type: "room_full"; data: { room: string; capacity: number } }
  // Liveness probe; the client answers with `pong`. See EVICTION_TIMEOUT_MS.
  | { type: "ping" }
  // Server-clock probe answer: the client's `c` echoed, and the server's time `s`.
  | { type: "time"; data: { c: number; s: number } }
  // A key's owner: granted, released (null), or — to a refused claimer alone —
  // whoever already holds it.
  | { type: "claim"; data: { key: string; owner: string | null; until?: number } }
  | { type: "claims_cleared"; data: { prefix: string } }
  // Tick rooms: tick `n`, with the inputs that changed on it (null = cleared).
  | { type: "tick"; data: { n: number; i: Record<string, JsonValue> } };

export interface MultiplayerRoomState {
  connectionStatus: MultiplayerConnectionStatus;
  playerId: string | null;
  hostId: string | null;
  sharedState: JsonRecord;
  players: PlayerMap;
}
