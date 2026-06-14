// Headless verification of the renderer-agnostic game core (no three.js).
// Run: npx tsx scripts/smoke.ts   →   exits non-zero on any failed assertion.

import { Board } from "../src/game/board";
import { Engine } from "../src/game/engine";
import { Piece } from "../src/game/piece";
import type { Pose } from "../src/input/camera";
import { PoseControls } from "../src/input/pose-control";
import { WELL_DEPTH, WELL_WIDTH } from "../src/shared/constants";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

// 1) Full layer clears on both axes and empties the board.
{
  const b = new Board();
  const cells = [];
  for (let x = 0; x < WELL_WIDTH; x++) {
    for (let z = 0; z < WELL_DEPTH; z++) cells.push({ x, y: 0, z });
  }
  b.lock(cells, 1);
  const r = b.clearLayer(0);
  check("full layer: xColumns = width", r.xColumns === WELL_WIDTH);
  check("full layer: zRows = depth", r.zRows === WELL_DEPTH);
  check("full layer: lines = width+depth", r.lines === WELL_WIDTH + WELL_DEPTH);
  let remaining = 0;
  b.forEachCube(() => (remaining += 1));
  check("full layer: board empty after", remaining === 0);
}

// 2) Single full column clears and the stack above drops one layer.
{
  const b = new Board();
  const col = [];
  for (let z = 0; z < WELL_DEPTH; z++) col.push({ x: 0, y: 0, z });
  b.lock(col, 1);
  b.lock([{ x: 0, y: 1, z: 0 }], 2); // a cube sitting above the cleared column
  const r = b.clearLayer(0);
  check("single column: 1 xColumn, 0 zRows", r.xColumns === 1 && r.zRows === 0);
  check("single column: cube above dropped to y=0", b.occupied(0, 0, 0));
  check("single column: old y=1 now empty", !b.occupied(0, 1, 0));
}

// 3) Dual-axis intersection clear reports both + counts the shared cube once.
{
  const b = new Board();
  const cells = [];
  for (let z = 0; z < WELL_DEPTH; z++) cells.push({ x: 0, y: 0, z }); // column x=0
  for (let x = 1; x < WELL_WIDTH; x++) cells.push({ x, y: 0, z: 0 }); // row z=0 (x=0 already added)
  b.lock(cells, 1);
  const r = b.clearLayer(0);
  check("dual axis: 1 xColumn + 1 zRow", r.xColumns === 1 && r.zRows === 1);
  check("dual axis: cubes counted once (width+depth-1)", r.cubes === WELL_WIDTH + WELL_DEPTH - 1);
}

// 4) Piece moves, rotates, and lands via the board.
{
  const b = new Board();
  const p = new Piece(0, b); // I piece
  const before = JSON.stringify(p.cells());
  check("piece: moves in +x", p.move(b, 1, 0));
  check("piece: position changed", JSON.stringify(p.cells()) !== before);
  const r0 = JSON.stringify(p.cells());
  p.rotate(b);
  check("piece: rotation changed footprint", JSON.stringify(p.cells()) !== r0);
  const landing = p.landingCells(b);
  check("piece: lands on the floor (min y === 0)", Math.min(...landing.map((c) => c.y)) === 0);
}

// 5) Engine plays: gravity locks a piece and spawns the next.
{
  const e = new Engine();
  e.startGame();
  check("engine: playing", e.state.status === "playing");
  check("engine: has active piece", e.activeCells().length > 0);
  // Drive ~30s of gravity in 16ms ticks — pieces lock & stack.
  let locks = 0;
  for (let i = 0; i < 2000 && e.state.status === "playing"; i++) {
    const ev = e.tick(16, false);
    if (ev) locks += 1;
  }
  check("engine: locked many pieces over time", locks > 3);
}

// 6) Hard drop locks immediately and returns an event.
{
  const e = new Engine();
  e.startGame();
  const ev = e.hardDrop();
  check("engine: hardDrop returns a lock event", ev !== null);
  check("engine: a new piece spawned after hardDrop", e.activeCells().length > 0);
}

// 7) Hold swaps the active piece and is limited to once per piece.
{
  const e = new Engine();
  e.startGame();
  const first = e.activePieceIndex();
  const held1 = e.hold();
  check("engine: hold succeeds", held1 === true);
  check("engine: held piece recorded", e.holdIndex === first);
  check("engine: hold is one-per-piece", e.hold() === false);
}

// 8) Power-sweep clears the lowest layer once charged.
{
  const e = new Engine();
  e.startGame();
  check("engine: not charged at start", e.canPower() === false);
  e.charge = 1; // simulate a full meter
  // lay a cube on the floor so there's something to sweep
  e.board.lock([{ x: 0, y: 0, z: 0 }], 1);
  const removed = e.power();
  check("engine: power removed cubes", removed > 0);
  check("engine: charge spent", e.canPower() === false);
}

// 9) board.sweepLowestLayer drops the stack above.
{
  const b = new Board();
  b.lock([{ x: 0, y: 0, z: 0 }], 1);
  b.lock([{ x: 0, y: 2, z: 0 }], 2);
  const removed = b.sweepLowestLayer();
  check("sweep: removed the lowest cube", removed === 1);
  check("sweep: upper cube dropped one", b.occupied(0, 1, 0) && !b.occupied(0, 2, 0));
}

// 10) Pose: circling a raised hand orbits the camera; a still hand does not.
{
  const W = 640;
  const H = 480;
  const makePose = (rwx: number, rwy: number): Pose => ({
    width: W,
    height: H,
    keypoints: [
      { name: "nose", x: 320, y: 150, score: 1 },
      { name: "left_shoulder", x: 260, y: 240, score: 1 },
      { name: "right_shoulder", x: 380, y: 240, score: 1 },
      { name: "left_hip", x: 270, y: 360, score: 1 },
      { name: "right_hip", x: 370, y: 360, score: 1 },
      { name: "left_wrist", x: 250, y: 250, score: 1 }, // resting hand
      { name: "right_wrist", x: rwx, y: rwy, score: 1 }, // the circling hand
    ],
  });

  const feed = (circle: boolean): number => {
    let orbits = 0;
    const controls = new PoseControls({
      steer: () => {},
      rotate: () => false,
      orbit: () => {
        orbits += 1;
      },
      hold: () => {},
      power: () => {},
      catchCollapse: () => {},
    });
    for (let i = 0; i < 24; i++) controls.handlePose(makePose(390, 250), null); // calibrate (still)
    for (let i = 0; i < 48; i++) {
      if (circle) {
        const a = (i / 16) * Math.PI * 2; // ~3 loops, raised above shoulders
        controls.handlePose(makePose(384 + Math.cos(a) * 60, 130 + Math.sin(a) * 60), null);
      } else {
        controls.handlePose(makePose(384, 130), null); // raised but still
      }
    }
    return orbits;
  };

  const circled = feed(true);
  const still = feed(false);
  check("pose: circling a raised hand orbits the camera", circled > 0);
  check("pose: a still raised hand does not orbit", still === 0);
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll game-core smoke checks passed.");
