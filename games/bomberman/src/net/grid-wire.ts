// The grid on the wire. The SDK re-sends an object or array key whole on every
// write, and the 285-cell grid is 4.8 KB of JSON, so it travels once per round
// (`grid`, written with the round) and every crate opened after that rides a
// compact string (`opened`): two base-36 characters per tile index.

import { GRID_COLS } from "../shared/constants";
import type { Cell } from "../shared/constants";

const CODE_WIDTH = 2;

/** Every crate in `base` that `current` has opened, as fixed-width tile codes in board order. */
export const encodeOpened = (base: Cell[][], current: Cell[][]): string => {
  let out = "";
  for (const [row, cells] of base.entries()) {
    for (const [col, cell] of cells.entries()) {
      if (cell.kind === "crate" && current[row]?.[col]?.kind === "empty") {
        out += (row * GRID_COLS + col).toString(36).padStart(CODE_WIDTH, "0");
      }
    }
  }
  return out;
};

/** `base` with the crates `opened` lists cleared. Returns `base` itself when nothing is open. */
export const applyOpened = (base: Cell[][], opened: string | undefined): Cell[][] => {
  if (!opened) {
    return base;
  }
  const grid = base.map((cells) => [...cells]);
  for (let i = 0; i + CODE_WIDTH <= opened.length; i += CODE_WIDTH) {
    const index = Number.parseInt(opened.slice(i, i + CODE_WIDTH), 36);
    const cells = grid[Math.floor(index / GRID_COLS)];
    const col = index % GRID_COLS;
    if (cells?.[col]?.kind === "crate") {
      cells[col] = { kind: "empty" };
    }
  }
  return grid;
};
