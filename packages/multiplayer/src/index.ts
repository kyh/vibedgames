export { MultiplayerClient } from "./client.js";
export type { MultiplayerClientOptions, MultiplayerSnapshot } from "./client.js";

export type {
  MultiplayerOptions,
  MultiplayerConnectionStatus,
  Player,
  PlayerMap,
  ClientMessage,
  SendEventOptions,
  ServerMessage,
} from "./types.js";
export {
  ROOM_CAP_QUERY_PARAM,
  RECONNECT_TOKEN_QUERY_PARAM,
  RECONNECT_GRACE_MS,
  DELTA_PATCH_QUERY_PARAM,
  HEARTBEAT_INTERVAL_MS,
  HOST_LIVENESS_TIMEOUT_MS,
  PING_INTERVAL_MS,
  EVICTION_TIMEOUT_MS,
} from "./types.js";

export type {
  MultiplayerSchemas,
  SchemaViolation,
  StandardSchemaV1,
  StandardSchemaIssue,
  StandardSchemaResult,
} from "./validation.js";
export { findStructuralIssue, MAX_MESSAGE_BYTES, MAX_STATE_DEPTH } from "./validation.js";
