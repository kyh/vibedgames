// Wire-JSON narrowing. Runtime `typeof` is banned by the lint; JSON only carries
// finite numbers, so Number.isFinite is the exact number test. Kept apart from
// the session so the headless harness can load the wire format under Node.

import type { JsonRecord, JsonValue } from "@vibedgames/multiplayer";

/** One field of a wire JSON dictionary — unvalidated until narrowed. */
export type WireField = JsonValue | undefined;

export const isJsonObject = (v: WireField): v is JsonRecord =>
  Object.prototype.toString.call(v) === "[object Object]";
export const isJsonNumber = (v: WireField): v is number => Number.isFinite(v);
export const numberOr = (v: WireField, fallback: number): number =>
  isJsonNumber(v) ? v : fallback;
