/**
 * JSON domain types and guards. The game is dependency-free, so these replace
 * a schema library: type the payload once at the parse boundary, then branch
 * on `JsonValue` with the guards instead of sniffing representations inline.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** `JSON.parse`, typed at the boundary: its output is `JsonValue` by construction. */
export function parseJsonText(text: string): JsonValue {
  return JSON.parse(text);
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Object(value) === value && !Array.isArray(value);
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return String(value) === value;
}

/** Finite numbers only — `NaN`/`Infinity` cannot come from JSON anyway. */
export function isFiniteJsonNumber(value: JsonValue | undefined): value is number {
  return Number.isFinite(value);
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return value === true || value === false;
}
