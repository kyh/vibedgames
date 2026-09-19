/**
 * JSON domain types and guards for the asset commands. asset-tools is
 * deliberately dependency-free, so these replace a schema library: parse the
 * payload once at the file boundary, then branch on `JsonValue` with the
 * guards instead of sniffing representations inline.
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
