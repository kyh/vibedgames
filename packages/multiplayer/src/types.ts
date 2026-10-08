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
  onEvent?: (event: string, payload: JsonValue, from: string) => void;
  /**
   * A claim's owner was set — granted (`owner` is the claimer), released
   * (`owner` null), or the server's answer to your own refused claim (`owner`
   * is whoever already holds it). See `MultiplayerClient.claim`.
   */
  onClaim?: (key: string, owner: string | null) => void;
}

/** Who holds each claimed key, and until when (server time, ms) for a claim with a TTL. */
export interface ClaimInfo {
  owner: string;
  until?: number;
}

export type ClaimMap = Record<string, ClaimInfo>;

/** Claims a room holds at most; past it new keys are refused. */
export const MAX_CLAIMS = 10_000;
/** Longest claim key (characters). */
export const MAX_CLAIM_KEY_LENGTH = 128;
/** Longest claim time-to-live (ms). */
export const MAX_CLAIM_TTL_MS = 3_600_000;
/** How often the SDK re-measures the server clock (ms). */
export const TIME_PROBE_INTERVAL_MS = 5000;

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
  | { type: "clear_claims"; data: { prefix: string } };

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
        /** Server time (ms) when the sync was sent. */
        time: number;
      };
    }
  | { type: "player_joined"; data: Player }
  | { type: "player_left"; data: { id: string } }
  | { type: "host"; data: { id: string } }
  | { type: "state_patch"; data: JsonRecord }
  | { type: "player_state"; data: { id: string; state: JsonRecord } }
  // A player's transport dropped (connected: false — seat held for the grace
  // window) or came back (connected: true).
  | { type: "player_connection"; data: { id: string; connected: boolean } }
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
  | { type: "claims_cleared"; data: { prefix: string } };

export interface MultiplayerRoomState {
  connectionStatus: MultiplayerConnectionStatus;
  playerId: string | null;
  hostId: string | null;
  sharedState: JsonRecord;
  players: PlayerMap;
}
