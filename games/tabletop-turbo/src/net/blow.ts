import type { JsonRecord } from "@vibedgames/multiplayer";

import type { Hit, HitHow } from "../sim/car";
import { HOWS } from "./pose";
import { isJsonNumber, isJsonObject, isJsonString, numberOr } from "./wire";
import type { WireField } from "./wire";

const BOARD = new Set<HitHow>(["bumper", "piston", "sweeper"]);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** A blow on its way to the client that simulates its victim. */
export const encodeHit: (hit: Hit) => JsonRecord = (hit) => ({
  b: hit.by,
  d: round2(hit.damage),
  i: hit.id,
  l: round2(hit.lift),
  n: HOWS.indexOf(hit.how),
  r: round2(hit.reach),
  s: round2(hit.stun),
  x: round2(hit.dx),
  z: round2(hit.dz),
});

/**
 * A blow somebody else dealt, or null if it is not one. The board's own toys
 * are never sent: each client lets them hit its own cars. Every number is held
 * to what the hardest real blow could carry.
 */
export const readHit: (value: WireField) => Hit | null = (value) => {
  if (!isJsonObject(value)) {
    return null;
  }

  const { b, i, r, x, z } = value;
  const how = HOWS[numberOr(value.n, -1)];

  if (!isJsonString(i) || !isJsonString(b) || !how || BOARD.has(how)) {
    return null;
  }

  if (!isJsonNumber(x) || !isJsonNumber(z) || !isJsonNumber(r)) {
    return null;
  }

  const length = Math.hypot(x, z) || 1;

  return {
    by: b,
    damage: clamp(numberOr(value.d, 0), 0, 40),
    dx: x / length,
    dz: z / length,
    how,
    id: i,
    lift: clamp(numberOr(value.l, 1), 0, 2),
    reach: clamp(r, 0, 26),
    stun: clamp(numberOr(value.s, 0), 0, 2),
  };
};
