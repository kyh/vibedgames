// JSON values at an I/O boundary (saves, fetched files, wire payloads),
// before their domain shape has been checked. Predicates narrow without
// `typeof` sniffing; JSON cannot encode NaN/Infinity/functions, so the
// checks cover the whole domain.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export const isJsonNumber = (v: JsonValue | undefined): v is number => Number.isFinite(v);

export const isJsonString = (v: JsonValue | undefined): v is string => String(v) === v;

/** A plain JSON object: not a primitive, not an array. */
export const isJsonObject = (v: JsonValue | undefined): v is JsonObject =>
  Object(v) === v && !Array.isArray(v);
