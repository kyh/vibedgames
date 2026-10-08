export { MultiplayerClient } from "./client.js";
export type { MultiplayerClientOptions, MultiplayerSnapshot } from "./client.js";

export { FixedRate } from "./fixed-rate.js";
export { Interpolator, lerp, lerpAngle } from "./interpolation.js";
export type { InterpolatorOptions } from "./interpolation.js";
export { RemoteClock } from "./remote-clock.js";
export type { RemoteClockOptions } from "./remote-clock.js";
export { Reconciler } from "./prediction.js";
export type { Correction, ReconcilerOptions } from "./prediction.js";

export type {
  ClientMessage,
  MultiplayerConnectionStatus,
  MultiplayerOptions,
  Player,
  PlayerMap,
  SendEventOptions,
  ServerMessage,
} from "./types.js";
export {
  EVICTION_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HOST_LIVENESS_TIMEOUT_MS,
  PING_INTERVAL_MS,
  RECONNECT_GRACE_MS,
  RECONNECT_TOKEN_QUERY_PARAM,
  ROOM_CAP_QUERY_PARAM,
} from "./types.js";

export type {
  MultiplayerSchemas,
  SchemaViolation,
  StandardSchemaV1,
  StandardSchemaIssue,
  StandardSchemaResult,
} from "./validation.js";
export { findStructuralIssue, MAX_MESSAGE_BYTES, MAX_STATE_DEPTH } from "./validation.js";
