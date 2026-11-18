/**
 * What the CLI's I/O boundaries actually produce: fal responses proxied
 * through `generate.forward`, config files, and any other `JSON.parse`
 * output. Values are narrowed from this closed union instead of sniffed
 * with `typeof`.
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

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  Object(value) === value && !Array.isArray(value);

export const isJsonString = (value: JsonValue | undefined): value is string =>
  String(value) === value;

export const isJsonNumber = (value: JsonValue | undefined): value is number =>
  Number.isFinite(value);
