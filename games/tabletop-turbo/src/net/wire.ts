import type { JsonRecord, JsonValue } from "@vibedgames/multiplayer";

/** One field of a wire JSON dictionary — unvalidated until narrowed. */
export type WireField = JsonValue | undefined;

export const isJsonObject = (v: WireField): v is JsonRecord =>
  Object.prototype.toString.call(v) === "[object Object]";

export const isJsonNumber = (v: WireField): v is number => Number.isFinite(v);

export const numberOr = (v: WireField, fallback: number) => (isJsonNumber(v) ? v : fallback);
