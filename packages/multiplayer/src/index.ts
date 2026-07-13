export { MultiplayerClient } from "./client.js";
export type { MultiplayerClientOptions, MultiplayerSnapshot } from "./client.js";

export type {
  MultiplayerOptions,
  MultiplayerConnectionStatus,
  Player,
  PlayerMap,
  ClientMessage,
  ServerMessage,
} from "./types.js";
export {
  ROOM_CAP_QUERY_PARAM,
  HEARTBEAT_INTERVAL_MS,
  HOST_LIVENESS_TIMEOUT_MS,
  PING_INTERVAL_MS,
  EVICTION_TIMEOUT_MS,
} from "./types.js";
