/**
 * Boundary parsing for external JSON (runner CLI stream events, blackboard
 * files, package manifests). `JSON.parse` returns `any`, so every reader
 * funnels through these helpers to get typed values without assertions.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Parse text as JSON, or undefined when malformed (JSON never encodes undefined). */
export function parseJson(text: string): JsonValue | undefined {
  try {
    const value: JsonValue = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

// `String(v) === v` / `Number(v) === v` hold exactly for primitive strings /
// numbers (strict equality never coerces), so these predicates are sound
// without a runtime `typeof`.
export const isJsonString = (value: JsonValue | undefined): value is string =>
  String(value) === value;

export const isJsonNumber = (value: JsonValue | undefined): value is number =>
  Number(value) === value;

export const asJsonObject = (value: JsonValue | undefined): JsonObject | undefined =>
  value instanceof Object && !Array.isArray(value) ? value : undefined;

export const asString = (value: JsonValue | undefined): string | undefined =>
  isJsonString(value) ? value : undefined;

export const asNumber = (value: JsonValue | undefined): number | undefined =>
  isJsonNumber(value) ? value : undefined;
