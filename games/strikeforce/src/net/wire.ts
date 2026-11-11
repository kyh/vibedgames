// Narrowing for what arrives off the wire. Payloads are unvalidated JSON until
// one of these says otherwise; JSON can only carry finite numbers, so
// Number.isFinite is the exact number test.
import type { JsonRecord, JsonValue } from "@vibedgames/multiplayer";
import { Vector3 } from "three";

type WireField = JsonValue | undefined;

export const isNum = (v: WireField): v is number => Number.isFinite(v);
export const isStr = (v: WireField): v is string => String(v) === v;
export const isRecord = (v: WireField): v is JsonRecord =>
  Object.prototype.toString.call(v) === "[object Object]";

/** A JSON array of numbers, at least `min` long, or null. */
export const nums = (v: WireField, min = 0): number[] | null => {
  if (!Array.isArray(v) || v.length < min) {
    return null;
  }
  const out: number[] = [];
  for (const item of v) {
    if (!isNum(item)) {
      return null;
    }
    out.push(item);
  }
  return out;
};

export const strs = (v: WireField): string[] => (Array.isArray(v) ? v.filter(isStr) : []);

export const numOr = (v: WireField, fallback: number): number => (isNum(v) ? v : fallback);

/** Three numbers starting at `at`, as a vector (into `out`). */
export const vecAt = (values: readonly number[], at: number, out = new Vector3()): Vector3 =>
  out.set(values[at] ?? 0, values[at + 1] ?? 0, values[at + 2] ?? 0);

/** A vector as three wire numbers, rounded to the millimetre. */
export const vecWire = (v: Vector3 | null | undefined): number[] =>
  v
    ? [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000]
    : [0, 0, 0];
