export { MultiplayerClient } from "./client.js";
export type { MultiplayerClientOptions, MultiplayerSnapshot } from "./client.js";
export { ServerClock } from "./server-clock.js";

export { FixedRate } from "./fixed-rate.js";
export { Interpolator, lerp, lerpAngle } from "./interpolation.js";
export type { InterpolatorOptions } from "./interpolation.js";
export { RemoteClock } from "./remote-clock.js";
export type { RemoteClockOptions, SenderClock } from "./remote-clock.js";
export { Reconciler } from "./prediction.js";
export type { Correction, ReconcilerOptions } from "./prediction.js";

export type {
  ClaimInfo,
  ClaimMap,
  ClientMessage,
  MultiplayerConnectionStatus,
  MultiplayerOptions,
  Player,
  PlayerLimit,
  PlayerMap,
  RoomRules,
  SendEventOptions,
  ServerMessage,
} from "./types.js";
export {
  EVICTION_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HOST_LIVENESS_TIMEOUT_MS,
  MAX_CLAIM_KEY_LENGTH,
  MAX_CLAIM_TTL_MS,
  MAX_CLAIMS,
  PING_INTERVAL_MS,
  RECONNECT_GRACE_MS,
  RECONNECT_TOKEN_QUERY_PARAM,
  ROOM_CAP_QUERY_PARAM,
  ROOM_RULES_QUERY_PARAM,
  TIME_PROBE_INTERVAL_MS,
} from "./types.js";

export type {
  MultiplayerSchemas,
  SchemaViolation,
  StandardSchemaV1,
  StandardSchemaIssue,
  StandardSchemaResult,
} from "./validation.js";
export { findStructuralIssue, MAX_MESSAGE_BYTES, MAX_STATE_DEPTH } from "./validation.js";
