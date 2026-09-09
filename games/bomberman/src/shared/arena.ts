import { newGrid } from "./constants";
import type { Cell } from "./constants";

export type Arena = "classic" | "crossroads";

/** Legacy rooms and unknown wire values keep the original courtyard. */
export function readArena(value: Arena | undefined): Arena {
  return value === "crossroads" ? "crossroads" : "classic";
}

/** Sample the original grid first so variation never changes its RNG trace. */
export function createArena(arena: Arena): Cell[][] {
  const grid = newGrid();
  if (arena === "classic") {
    return grid;
  }
  const middleRow = Math.floor(grid.length / 2);
  for (const [r, row] of grid.entries()) {
    const middleCol = Math.floor(row.length / 2);
    for (const [c, cell] of row.entries()) {
      if (cell.kind === "crate" && (r === middleRow || c === middleCol)) {
        row[c] = { kind: "empty" };
      }
    }
  }
  return grid;
}
