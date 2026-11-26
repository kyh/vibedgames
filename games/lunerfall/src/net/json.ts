export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [k: string]: JsonValue;
}

export const isJsonObject = (v: JsonValue | undefined): v is JsonObject =>
  v instanceof Object && !Array.isArray(v);

export const isJsonNumber = (v: JsonValue | undefined): v is number => Number.isFinite(v);

export const isJsonString = (v: JsonValue | undefined): v is string =>
  Object.prototype.toString.call(v) === "[object String]";

const isJsonLeaf = (v: unknown): v is string | number | boolean | null =>
  v === null ||
  v === true ||
  v === false ||
  Number.isFinite(v) ||
  Object.prototype.toString.call(v) === "[object String]";

/** Narrows an engine-typed `any` (Phaser's caches and registry) to the JSON it holds. */
export const isJsonValue = (v: unknown): v is JsonValue => {
  if (isJsonLeaf(v)) {
    return true;
  }

  if (Array.isArray(v)) {
    return v.every((item) => isJsonValue(item));
  }

  return (
    v instanceof Object &&
    Object.getPrototypeOf(v) === Object.prototype &&
    Object.values(v).every((item) => isJsonValue(item))
  );
};
