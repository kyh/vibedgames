import * as z from "zod/mini";

/**
 * JSON domain types and guards for the asset commands: parse the payload once
 * at the file boundary, then branch on `JsonValue` with the guards instead of
 * sniffing representations inline.
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

/** `JSON.parse`, checked at the boundary into a `JsonValue`. */
export const parseJsonText = (text: string) => {
  const value: JsonValue = z.json().parse(JSON.parse(text));

  return value;
};

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  Object(value) === value && !Array.isArray(value);

export const isJsonString = (value: JsonValue | undefined): value is string =>
  Object.prototype.toString.call(value) === "[object String]";

/** Finite numbers only — `NaN`/`Infinity` cannot come from JSON anyway. */
export const isFiniteJsonNumber = (value: JsonValue | undefined): value is number =>
  Number.isFinite(value);
