// The JSON wire domain. Multiplayer payloads and shared-state values arrive
// as JSON websocket frames (or local echoes of JSON-safe sends), so the SDK's
// JsonValue names their entire input domain — parsers take it instead of
// `unknown`. The guards below discriminate scalars without `typeof` by
// exploiting JSON's limits: JSON.parse never yields NaN/Infinity, boxed
// primitives, or functions.

import type { JsonRecord, JsonValue } from "@vibedgames/multiplayer";

export type { JsonRecord as JsonObject, JsonValue } from "@vibedgames/multiplayer";

export const isJsonObject = (v: JsonValue | undefined): v is JsonRecord =>
  v instanceof Object && !Array.isArray(v);

export const isJsonNumber = (v: JsonValue | undefined): v is number => Number.isFinite(v);

export const isJsonString = (v: JsonValue | undefined): v is string => String(v) === v;
