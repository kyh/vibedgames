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

export type MultiplayerConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export type PlayerState<T = Record<string, unknown>> = T;

export type Player = {
  id: string;
  color?: string;
  hue?: string;
  state?: PlayerState;
};

export type PlayerMap = Record<string, Player>;

export type ClientMessage =
  | { type: "state_patch"; data: Record<string, unknown> }
  | { type: "player_state_patch"; data: Record<string, unknown> }
  | { type: "emit"; data: { event: string; payload: unknown } }
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
