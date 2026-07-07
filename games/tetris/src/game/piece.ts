// The active falling slab. Flat in the XZ plane (1 layer tall), translates in
// X and Z, rotates 90° clockwise in that plane with a wall-kick. Cleaner than
// the reference's per-cube pivot (which gave inconsistent rotation centres):
// here the footprint matrix rotates whole, then the origin is nudged back
// inside the walls before the move is accepted.

import { type Board, type Cell, rotateCW } from "./board";
import { PIECES, WELL_HEIGHT } from "../shared/constants";

export class Piece {
  readonly index: number;
  /** Colour index stored in the board on lock (PIECES index + 1). */
  readonly colorIndex: number;
  private matrix: number[][];
  private ox: number;
  private oz: number;
  private y: number;

  constructor(index: number, board: Board) {
    this.index = index;
    this.colorIndex = index + 1;
    const def = PIECES[index];
    this.matrix = (def?.shape ?? [[1]]).map((row) => [...row]);
    const cols = this.matrix[0]?.length ?? 1;
    const rows = this.matrix.length;
    this.ox = Math.floor((board.width - cols) / 2);
    this.oz = Math.floor((board.depth - rows) / 2);
    this.y = WELL_HEIGHT - 1;
  }

  /** Current world cells (all share this.y). */
  cells(): Cell[] {
    return this.cellsAt(this.matrix, this.ox, this.oz, this.y);
  }

  private cellsAt(m: number[][], ox: number, oz: number, y: number): Cell[] {
    const out: Cell[] = [];
    for (let r = 0; r < m.length; r++) {
      const row = m[r] ?? [];
      for (let c = 0; c < row.length; c++) {
        if (row[c]) out.push({ x: ox + c, y, z: oz + r });
      }
    }
    return out;
  }

  /** Translate in the floor plane if it fits. Returns whether it moved. */
  move(board: Board, dx: number, dz: number): boolean {
    const next = this.cellsAt(this.matrix, this.ox + dx, this.oz + dz, this.y);
    if (board.collides(next)) return false;
    this.ox += dx;
    this.oz += dz;
    return true;
  }

  /** Step down one layer; returns false if it locked (couldn't descend). */
  fall(board: Board): boolean {
    const next = this.cellsAt(this.matrix, this.ox, this.oz, this.y - 1);
    if (board.collides(next)) return false;
    this.y -= 1;
    return true;
  }

  /** Rotate 90° CW in the XZ plane, kicking off walls. Returns whether it rotated. */
  rotate(board: Board): boolean {
    const m = rotateCW(this.matrix);
    let ox = this.ox;
    let oz = this.oz;
    const cols = m[0]?.length ?? 0;
    const rows = m.length;
    // Kick the whole footprint back inside the x/z walls.
    if (ox < 0) ox = 0;
    if (oz < 0) oz = 0;
    if (ox + cols > board.width) ox = board.width - cols;
    if (oz + rows > board.depth) oz = board.depth - rows;
    const next = this.cellsAt(m, ox, oz, this.y);
    if (board.collides(next)) return false; // wall-kick failed → locked cube in the way
    this.matrix = m;
    this.ox = ox;
    this.oz = oz;
    return true;
  }

  /** Cells where the slab would come to rest if hard-dropped now (the ghost). */
  landingCells(board: Board): Cell[] {
    let y = this.y;
    while (!board.collides(this.cellsAt(this.matrix, this.ox, this.oz, y - 1))) {
      y -= 1;
    }
    return this.cellsAt(this.matrix, this.ox, this.oz, y);
  }
}
