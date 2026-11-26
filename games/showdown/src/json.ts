import type { MultiplayerClient } from "@vibedgames/multiplayer";

export type JsonValue = Parameters<MultiplayerClient["sendEvent"]>[1];

export interface JsonObject {
  [key: string]: JsonValue;
}

export const isJsonObject = (v: JsonValue | undefined): v is JsonObject =>
  v instanceof Object && !Array.isArray(v);

export const isJsonNumber = (v: JsonValue | undefined): v is number => Number.isFinite(v);

export const isJsonString = (v: JsonValue | undefined): v is string =>
  Object.prototype.toString.call(v) === "[object String]";

export const isJsonBoolean = (v: JsonValue | undefined): v is boolean => v === true || v === false;

/** `JSON.parse`, typed at the boundary: a parse that is not plain JSON throws. */
export { parseJson } from "@vibedgames/multiplayer";
