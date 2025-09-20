import type { Dispatch, SetStateAction } from "react";

export type SharedState<T = Record<string, unknown>> = T;

export type PlayerState<T = Record<string, unknown>> = T;

export type Player<TState = PlayerState> = {
  id: string;
  color?: string;
  hue?: string;
  state: TState;
  metadata?: Record<string, unknown>;
};

export type PlayerMap<TState = PlayerState> = Record<string, Player<TState>>;

export type MultiplayerConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type MultiplayerProviderConfig<TShared, TPlayer> = {
  host: string;
  party: string;
  room: string;
  initialSharedState?: TShared;
  initialPlayerState?: TPlayer;
};

export type MultiplayerContextValue<TShared, TPlayer> = {
  socket: WebSocket | null;
  selfId: string | null;
  hostId: string | null;
  players: PlayerMap<TPlayer>;
  sharedState: TShared;
  status: MultiplayerConnectionStatus;
  setSharedState: Dispatch<SetStateAction<TShared>>;
  setPlayerState: (updater: SetStateAction<TPlayer>, playerId?: string) => void;
  getPlayerState: (playerId: string) => TPlayer | undefined;
};

export type ClientMessage<TData = unknown> =
  | { type: "set_state"; data: TData }
  | { type: "set_player_state"; data: TData }
  | { type: "set_metadata"; data: Record<string, unknown> }
  | { type: "emit"; data: { event: string; payload: unknown } };

export type ServerMessage<TShared, TPlayer> =
  | {
      type: "init";
      data: {
        selfId: string;
        hostId: string | null;
        players: PlayerMap<TPlayer>;
        sharedState: TShared;
      };
    }
  | { type: "player_joined"; data: Player<TPlayer> }
  | { type: "player_left"; data: { id: string } }
  | { type: "player_updated"; data: Player<TPlayer> }
  | { type: "shared_state"; data: TShared }
  | { type: "host_changed"; data: { hostId: string | null } }
  | {
      type: "custom_event";
      data: { event: string; payload: unknown; from: string };
    };
