import {
  CRATE_BEAM,
  CRATE_EVERY,
  ITEMS_AT,
  ROUND_MS,
  SHRINK_MS,
  SHRINK_WARN_MS,
} from "../shared/constants";
import type { ItemKind } from "../shared/constants";
import type { Arena } from "./arena";

export interface Crate {
  index: number;
  kind: ItemKind;
  x: number;
  z: number;
  /** Seconds into the round it lands; the beam shows from `CRATE_BEAM` before. */
  landAt: number;
}

const hash = (a: number, b: number) => {
  const v = Math.sin(a * 127.1 + b * 311.7 + 17.3) * 43_758.5453;

  return v - Math.floor(v);
};

const LATE_AT = (ROUND_MS - SHRINK_MS + SHRINK_WARN_MS) / 1000;

/** Crate number `index` of `round`: every client works out the same one. */
export const crateOf: (arena: Arena, round: number, index: number) => Crate = (
  arena,
  round,
  index,
) => {
  const landAt = ITEMS_AT + index * CRATE_EVERY;
  const roll = hash(round, index);
  const side = hash(index, round + 5) < 0.5 ? 0 : 1;
  const ends = index % 2 === 0 && landAt + CRATE_EVERY < LATE_AT;
  const pads = ends ? arena.def.knockerPads : arena.def.carPads;
  const [x, z] = pads[side % Math.max(1, pads.length)] ?? [0, 0];
  const bumper: ItemKind = roll < 0.5 ? "mega" : "spring";
  const body: ItemKind = roll < 0.5 ? "giant" : "turbo";

  return {
    index,
    kind: index % 2 === 0 ? bumper : body,
    landAt,
    x,
    z,
  };
};

/**
 * The crate on the board (or on its way down) at `time` seconds into the round,
 * or null between crates. One at a time: a crate nobody takes goes when the
 * next one's beam comes on.
 */
export const crateAt = (arena: Arena, round: number, time: number) => {
  const end = ROUND_MS / 1000;
  const due = Math.floor((time - ITEMS_AT + CRATE_BEAM) / CRATE_EVERY);
  const index = ITEMS_AT + due * CRATE_EVERY < end ? due : due - 1;

  if (index < 0 || time >= end) {
    return null;
  }

  return crateOf(arena, round, index);
};
