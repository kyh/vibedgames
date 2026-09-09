import { Board } from "./board";
import type { Cell, ClearResult } from "./board";
import { Piece } from "./piece";

export interface TeachingExample {
  title: string;
  body: string;
  hint: string;
  cells: Cell[];
  landing: Cell[];
  clear: ClearResult | null;
}

/** Isolated real boards keep the examples tied to the game's spatial rules. */
export function teachingExamples(): TeachingExample[] {
  const single = new Board();
  const row = Array.from({ length: single.width }, (_, x) => ({ x, y: 2, z: 3 }));
  single.lock(row, 1);
  const singleClear = single.clearLayer(2);

  const crossing = new Board();
  const cross = [
    ...row,
    ...Array.from({ length: crossing.depth }, (_, z) => ({ x: 3, y: 2, z })).filter(
      (cell) => cell.z !== 3,
    ),
  ];
  crossing.lock(cross, 3);
  const crossedClear = crossing.clearLayer(2);

  const landingBoard = new Board();
  const obstacles = [
    { x: 3, y: 0, z: 3 },
    { x: 3, y: 1, z: 3 },
    { x: 5, y: 0, z: 4 },
  ];
  landingBoard.lock(obstacles, 6);
  const piece = new Piece(2, landingBoard);
  return [
    {
      body: "Fill a row at one height. Either floor direction clears.",
      cells: row,
      clear: singleClear,
      hint: "Power sweeps the lowest occupied level.",
      landing: [],
      title: `${singleClear.cubes} across or ${singleClear.cubes} deep.`,
    },
    {
      body: "Orbit to find gaps. The wireframe marks where your slab will land.",
      cells: obstacles,
      clear: null,
      hint: "Movement follows your view. The landing cells stay in the well.",
      landing: piece.landingCells(landingBoard),
      title: "Read the landing outline.",
    },
    {
      body: "Complete both directions together for the crossed-clear bonus.",
      cells: cross,
      clear: crossedClear,
      hint: "Hands up can catch a collapse. Packed gaps may save the stack.",
      landing: [],
      title: `${crossedClear.lines} lines. ${crossedClear.cubes} cubes.`,
    },
  ];
}
