// The active falling slab. Flat in the XZ plane (1 layer tall), translates in
// X and Z, rotates 90° clockwise in that plane with a wall-kick. Cleaner than
// the reference's per-cube pivot (which gave inconsistent rotation centres):
// here the footprint matrix rotates whole, then the origin is nudged back
// inside the walls before the move is accepted.

import { rotateCW } from "./board";
import type { Board, Cell } from "./board";
import { PIECES, WELL_HEIGHT } from "../shared/constants";

export class Piece {
  readonly index: number;
  /** Colour index stored in the board on lock (PIECES index + 1). */
  readonly colorIndex: number;
  private matrix: number[][];
  private ox: number;
  private oz: number;
  private y: number;
  private turns = 0;

  constructor(index: number, board: Board) {
    this.index = index;
    this.colorIndex = index + 1;
    const def = PIECES[index];
    this.matrix = (def?.footprint ?? [[1]]).map((row) => [...row]);
    const cols = this.matrix[0]?.length ?? 1;
    const rows = this.matrix.length;
    this.ox = Math.floor((board.width - cols) / 2);
    this.oz = Math.floor((board.depth - rows) / 2);
    this.y = WELL_HEIGHT - 1;
  }

  /** Current world cells (all share this.y). */
  cells(): Cell[] {
    return Piece.cellsAt(this.matrix, this.ox, this.oz, this.y);
  }

  private static cellsAt(m: number[][], ox: number, oz: number, y: number): Cell[] {
    const out: Cell[] = [];
    for (let r = 0; r < m.length; r += 1) {
      const row = m[r] ?? [];
      for (let c = 0; c < row.length; c += 1) {
        if (row[c]) {
          out.push({ x: ox + c, y, z: oz + r });
        }
      }
    }
    return out;
  }

  /** Translate in the floor plane if it fits. Returns whether it moved. */
  move(board: Board, dx: number, dz: number): boolean {
    const next = Piece.cellsAt(this.matrix, this.ox + dx, this.oz + dz, this.y);
    if (board.collides(next)) {
      return false;
    }
    this.ox += dx;
    this.oz += dz;
    return true;
  }

  /** Step down one layer; returns false if it locked (couldn't descend). */
  fall(board: Board): boolean {
    const next = Piece.cellsAt(this.matrix, this.ox, this.oz, this.y - 1);
    if (board.collides(next)) {
      return false;
    }
    this.y -= 1;
    return true;
  }

  /** Quarter turns clockwise from the spawn orientation, 0..3. */
  get rotation(): number {
    return this.turns;
  }

  /** Cells after one clockwise turn (wall-kicked), or null if it would not fit. */
  rotatedCells(board: Board): Cell[] | null {
    const next = this.rotated(board);
    return next ? Piece.cellsAt(next.matrix, next.ox, next.oz, this.y) : null;
  }

  /** Rotate 90° CW in the XZ plane, kicking off walls. Returns whether it rotated. */
  rotate(board: Board): boolean {
    const next = this.rotated(board);
    if (!next) {
      return false;
    }
    this.matrix = next.matrix;
    this.ox = next.ox;
    this.oz = next.oz;
    this.turns = (this.turns + 1) % 4;
    return true;
  }

  private rotated(board: Board): { matrix: number[][]; ox: number; oz: number } | null {
    const m = rotateCW(this.matrix);
    let { ox } = this;
    let { oz } = this;
    const cols = m[0]?.length ?? 0;
    const rows = m.length;
    // Kick the whole footprint back inside the x/z walls.
    if (ox < 0) {
      ox = 0;
    }
    if (oz < 0) {
      oz = 0;
    }
    if (ox + cols > board.width) {
      ox = board.width - cols;
    }
    if (oz + rows > board.depth) {
      oz = board.depth - rows;
    }
    // A locked cube in the way defeats the wall-kick.
    if (board.collides(Piece.cellsAt(m, ox, oz, this.y))) {
      return null;
    }
    return { matrix: m, ox, oz };
  }

  /** Cells where the slab would come to rest if hard-dropped now (the ghost). */
  landingCells(board: Board): Cell[] {
    let { y } = this;
    while (!board.collides(Piece.cellsAt(this.matrix, this.ox, this.oz, y - 1))) {
      y -= 1;
    }
    return Piece.cellsAt(this.matrix, this.ox, this.oz, y);
  }
}
