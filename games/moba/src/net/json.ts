import type { JsonRecord, JsonValue } from "@vibedgames/multiplayer";

export type { JsonRecord as JsonObject, JsonValue } from "@vibedgames/multiplayer";

export const isJsonObject = (v: JsonValue | undefined): v is JsonRecord =>
  v instanceof Object && !Array.isArray(v);

export const isJsonNumber = (v: JsonValue | undefined): v is number => Number.isFinite(v);

export const isJsonString = (v: JsonValue | undefined): v is string =>
  Object.prototype.toString.call(v) === "[object String]";
