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

export interface JsonObject {
  [key: string]: JsonValue;
}

/** `JSON.parse`, typed at the boundary: its output is `JsonValue` by construction. */
export const parseJsonText = (text: string): JsonValue => JSON.parse(text);

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  Object(value) === value && !Array.isArray(value);

export const isJsonString = (value: JsonValue | undefined): value is string =>
  String(value) === value;

/** Finite numbers only — `NaN`/`Infinity` cannot come from JSON anyway. */
export const isFiniteJsonNumber = (value: JsonValue | undefined): value is number =>
  Number.isFinite(value);

export const isJsonBoolean = (value: JsonValue | undefined): value is boolean =>
  value === true || value === false;
