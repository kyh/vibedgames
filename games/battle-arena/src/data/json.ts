// The JSON wire domain. Map files, localStorage drafts, and net snapshot
// payloads arrive as parsed JSON, so JsonValue names their entire input
// domain — parsers take it instead of `unknown`. The guards discriminate
// scalars without `typeof` by exploiting JSON's limits: JSON.parse never
// yields NaN/Infinity, boxed primitives, or functions.

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [k: string]: JsonValue };

export function isJsonObject(v: JsonValue | undefined): v is JsonObject {
  return v instanceof Object && !Array.isArray(v);
}

export function isJsonNumber(v: JsonValue | undefined): v is number {
  return Number.isFinite(v);
}

export function isJsonString(v: JsonValue | undefined): v is string {
  return String(v) === v;
}
