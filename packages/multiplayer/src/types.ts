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
  | { type: "emit"; data: { event: string; payload: unknown } };

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
  | { type: "room_full"; data: { room: string; capacity: number } };

export type MultiplayerRoomState = {
  connectionStatus: MultiplayerConnectionStatus;
  playerId: string | null;
  hostId: string | null;
  sharedState: Record<string, unknown>;
  players: PlayerMap;
};
