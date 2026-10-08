// The shared board on the wire: which pellet cells the host has awarded this
// round, as one short string. Every client derives the same pellet list from
// the static MAP, so the board needs only a bit per pellet cell — the 362
// cells pack into 61 characters. A string is also a primitive, which the SDK
// diffs; an object key rides the wire whole on every patch, and the old
// `{ "col,row": 1 }` set grew to 3.4 KB per claim by the end of a round.

import { MAP, cellKey } from "../shared/constants";

/** Pellet and heart cells in row-major order: bit i of the wire board is cell i. */
export const PELLET_KEYS: readonly string[] = MAP.flatMap((cells, row) =>
  cells.flatMap((type, col) => (type === 2 || type === 3 ? [cellKey(col, row)] : [])),
);

/** URL-safe base64 digits; digit d carries cells 6d … 6d+5, cell 6d + k as its 2^k bit. */
const DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BITS_PER_DIGIT = 6;

/** The eaten set as a wire string. Keys that are not pellet cells are left out. */
export const encodeEaten = (eaten: ReadonlySet<string>): string => {
  let wire = "";
  for (let first = 0; first < PELLET_KEYS.length; first += BITS_PER_DIGIT) {
    let digit = 0;
    for (let bit = 0; bit < BITS_PER_DIGIT; bit += 1) {
      const key = PELLET_KEYS[first + bit];
      if (key !== undefined && eaten.has(key)) {
        digit += 2 ** bit;
      }
    }
    wire += DIGITS.charAt(digit);
  }
  return wire;
};

/**
 * The pellet keys a wire string marks eaten. It comes off the wire, so a
 * character outside the alphabet, or one past the pellet list, reads as
 * nothing eaten rather than as some other cell.
 */
export const decodeEaten = (wire: string): string[] => {
  const keys: string[] = [];
  for (let index = 0; index < wire.length; index += 1) {
    // A non-digit (-1) reads as 0: nothing eaten.
    const digit = Math.max(0, DIGITS.indexOf(wire.charAt(index)));
    for (let bit = 0; bit < BITS_PER_DIGIT; bit += 1) {
      const key = PELLET_KEYS[index * BITS_PER_DIGIT + bit];
      if (key !== undefined && Math.floor(digit / 2 ** bit) % 2 === 1) {
        keys.push(key);
      }
    }
  }
  return keys;
};
