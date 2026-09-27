// The JSON domain, derived from what the multiplayer client accepts as an
// event payload so the snapshot and fx types are checked against the SDK's own
// contract; localStorage reads share it. The guards discriminate scalars
// without `typeof` by leaning on JSON's limits: parsed JSON never yields NaN,
// boxed primitives or functions.
import type { MultiplayerClient } from "@vibedgames/multiplayer";

export type JsonValue = Parameters<MultiplayerClient["sendEvent"]>[1];
export interface JsonObject {
  [key: string]: JsonValue;
}

export const isJsonObject = (v: JsonValue | undefined): v is JsonObject =>
  v instanceof Object && !Array.isArray(v);

export const isJsonNumber = (v: JsonValue | undefined): v is number => Number.isFinite(v);

export const isJsonString = (v: JsonValue | undefined): v is string => String(v) === v;

export const isJsonBoolean = (v: JsonValue | undefined): v is boolean => v === true || v === false;

/** `JSON.parse`, typed at the boundary: its output is a JSON value by construction. */
export const parseJson = (text: string): JsonValue => JSON.parse(text);
