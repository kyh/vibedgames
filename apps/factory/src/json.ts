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

export interface JsonObject {
  [key: string]: JsonValue;
}

/** Parse text as JSON, or undefined when malformed (JSON never encodes undefined). */
export const parseJson = (text: string) => {
  let value: JsonValue | undefined;

  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }

  return value;
};

export const isJsonString = (value: JsonValue | undefined): value is string =>
  String(value) === value;

export const isJsonNumber = (value: JsonValue | undefined): value is number =>
  Number(value) === value;

export const asJsonObject = (value: JsonValue | undefined) =>
  value instanceof Object && !Array.isArray(value) ? value : undefined;

export const asString = (value: JsonValue | undefined) => (isJsonString(value) ? value : undefined);

export const asNumber = (value: JsonValue | undefined) => (isJsonNumber(value) ? value : undefined);
