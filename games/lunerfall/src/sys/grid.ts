import { BASE_H, BASE_W, TILE } from "../config";

// Pure collision grid — no Phaser, so it runs in the headless sim harness.
// 0 = empty, 1 = solid, 2 = one-way (jump-through). Out-of-bounds is solid on
// the sides + bottom (invisible walls / floor) and empty above the top.
// Size-parametric: rooms are no longer locked to one screen — a Grid is built at
// whatever col/row extent the room needs, and the camera scrolls over it. COLS/
// ROWS are the single-screen defaults (viewport size in tiles).
export const COLS = Math.floor(BASE_W / TILE); // 30
export const ROWS = Math.ceil(BASE_H / TILE); // 17

const EPS = 0.0001;

export class Grid {
  readonly cols: number;
  readonly rows: number;
  readonly cells: Uint8Array;

  constructor(cols: number = COLS, rows: number = ROWS) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Uint8Array(cols * rows);
  }

  set(cx: number, cy: number, v: number) {
    if (cx < 0 || cx >= this.cols || cy < 0 || cy >= this.rows) return;
    this.cells[cy * this.cols + cx] = v;
  }

  fill(cx0: number, cy0: number, cx1: number, cy1: number, v: number) {
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) this.set(x, y, v);
  }

  // Hand-built gray-box arena that exercises every movement mechanic.
  static test(): Grid {
    const g = new Grid();
    for (let y = 0; y < g.rows; y++) {
      g.set(0, y, 1);
      g.set(g.cols - 1, y, 1);
    }
    g.fill(0, g.rows - 2, g.cols - 1, g.rows - 1, 1); // floor
    g.fill(6, 10, 10, 10, 1); // left solid ledge
    g.fill(g.cols - 11, 10, g.cols - 7, 10, 1); // right solid ledge
    g.fill(12, 6, 17, 6, 2); // top one-way
    g.fill(3, 12, 7, 12, 2); // low-left one-way
    g.fill(g.cols - 8, 12, g.cols - 4, 12, 2); // low-right one-way
    return g;
  }

  isSolidCell(cx: number, cy: number): boolean {
    if (cx < 0 || cx >= this.cols || cy >= this.rows) return true;
    if (cy < 0) return false;
    return this.cells[cy * this.cols + cx] === 1;
  }

  isOneWayCell(cx: number, cy: number): boolean {
    if (cx < 0 || cx >= this.cols || cy < 0 || cy >= this.rows) return false;
    return this.cells[cy * this.cols + cx] === 2;
  }

  solidInRect(l: number, t: number, rt: number, b: number): boolean {
    const cx0 = Math.floor(l / TILE);
    const cx1 = Math.floor((rt - EPS) / TILE);
    const cy0 = Math.floor(t / TILE);
    const cy1 = Math.floor((b - EPS) / TILE);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) if (this.isSolidCell(cx, cy)) return true;
    return false;
  }

  oneWayInRect(l: number, t: number, rt: number, b: number): boolean {
    const cx0 = Math.floor(l / TILE);
    const cx1 = Math.floor((rt - EPS) / TILE);
    const cy0 = Math.floor(t / TILE);
    const cy1 = Math.floor((b - EPS) / TILE);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) if (this.isOneWayCell(cx, cy)) return true;
    return false;
  }
}
