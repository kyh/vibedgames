// The JSON wire domain. Map files, localStorage drafts, and net snapshot
// payloads arrive as parsed JSON, so JsonValue names their entire input
// domain — parsers take it instead of `unknown`. The guards discriminate
// scalars without `typeof` by exploiting JSON's limits: JSON.parse never
// yields NaN/Infinity, boxed primitives, or functions.

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [k: string]: JsonValue;
}

export const isJsonObject = (v: JsonValue | undefined): v is JsonObject =>
  v instanceof Object && !Array.isArray(v);

export const isJsonNumber = (v: JsonValue | undefined): v is number => Number.isFinite(v);

export const isJsonString = (v: JsonValue | undefined): v is string => String(v) === v;
