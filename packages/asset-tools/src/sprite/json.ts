/**
 * Hand-edited JSON (manifests, size contracts) arrives shapeless. Naming the
 * parse target and narrowing through these guards keeps every consumer branch
 * on a checked domain value instead of a raw `typeof` probe.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
// `undefined` values model keys that JSON.stringify drops, so structures with
// optional properties still count as JSON.
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** JSON cannot encode NaN/Infinity, so finiteness alone identifies a number. */
export const isFiniteNumber = (value: JsonValue | undefined): value is number =>
  Number.isFinite(value);

export const isString = (value: JsonValue | undefined): value is string => String(value) === value;

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  Object(value) === value && !Array.isArray(value);

/** Any non-primitive — object or array — mirroring a null-guarded `typeof "object"`. */
export const isJsonComposite = (value: JsonValue | undefined): value is JsonObject | JsonValue[] =>
  Object(value) === value;

/** String-keyed read from a closed const table without widening the table's type. */
export const lookup = <T>(table: Record<string, T>, key: string): T | undefined => table[key];
