export type MultiplayerOptions = {
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
  onEvent?: (event: string, payload: unknown, from: string) => void;
};

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

export type PlayerState<T = Record<string, unknown>> = T;

export type Player = {
  id: string;
  color?: string;
  hue?: string;
  state?: PlayerState;
  /**
   * False while the player's transport is down but their seat is being held
   * for a reconnect (see RECONNECT_GRACE_MS) — render a "reconnecting…"
   * treatment instead of removing them. Absent on servers that predate
   * reconnection grace; treat missing as connected.
   */
  connected?: boolean;
};

export type PlayerMap = Record<string, Player>;

/**
 * Delivery targeting for `sendEvent`. Omit for the default broadcast to every
 * player in the room (including the sender).
 *
 * - `to`: deliver only to these player ids. The sender is included only if its
 *   own id is listed.
 * - `except`: exclude these player ids (applied after `to`, if both given).
 *
 * Targeting is enforced by the party server; a server predating it ignores
 * these fields and falls back to broadcasting to everyone.
 */
export type SendEventOptions = {
  to?: string | string[];
  except?: string | string[];
};

export type ClientMessage =
  | { type: "state_patch"; data: Record<string, unknown> }
  | { type: "player_state_patch"; data: Record<string, unknown> }
  // `to`/`except` are additive so servers and clients on either side of the
  // targeting feature interoperate: absent fields mean broadcast-to-all.
  | { type: "emit"; data: { event: string; payload: unknown; to?: string[]; except?: string[] } }
  // Liveness ping sent on an interval so the server can detect a host that has
  // gone away ungracefully (laptop sleep, crashed tab, dropped network) without
  // waiting for the WebSocket's much-longer TCP timeout, and migrate host.
  | { type: "heartbeat" }
  // Reply to the server's `ping`. Distinct from `heartbeat` on purpose — see
  // the note on EVICTION_TIMEOUT_MS below.
  | { type: "pong" };

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
  | { type: "sync"; data: { players: PlayerMap; state: Record<string, unknown>; hostId: string } }
  | { type: "player_joined"; data: Player }
  | { type: "player_left"; data: { id: string } }
  | { type: "host"; data: { id: string } }
  | { type: "state_patch"; data: Record<string, unknown> }
  | { type: "player_state"; data: { id: string; state: Record<string, unknown> } }
  // A player's transport dropped (connected: false — seat held for the grace
  // window) or came back (connected: true). Pre-grace clients ignore this and
  // simply see the player leave when the window lapses.
  | { type: "player_connection"; data: { id: string; connected: boolean } }
  | { type: "event"; data: { event: string; payload: unknown; from: string } }
  // Sent (then the socket is closed) when a player connects to a room that is
  // already at capacity. `room` is the sibling room the client should retry.
  | { type: "room_full"; data: { room: string; capacity: number } }
  // Liveness probe; the client answers with `pong`. See EVICTION_TIMEOUT_MS.
  | { type: "ping" };

export type MultiplayerRoomState = {
  connectionStatus: MultiplayerConnectionStatus;
  playerId: string | null;
  hostId: string | null;
  sharedState: Record<string, unknown>;
  players: PlayerMap;
};
