export type MultiplayerOptions = {
  host: string;
  party: string;
  room: string;
};

export type MultiplayerConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

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
  | { type: "event"; data: { event: string; payload: unknown; from: string } };

export type MultiplayerRoomState = {
  connectionStatus: MultiplayerConnectionStatus;
  playerId: string | null;
  hostId: string | null;
  sharedState: Record<string, unknown>;
  players: PlayerMap;
};
