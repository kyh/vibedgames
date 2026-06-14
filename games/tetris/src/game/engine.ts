// The renderer-agnostic game core. Owns the board, the active slab, the
// 7-bag, the fixed-timestep gravity tick, and lock→clear→spawn. Player verbs
// take raw world deltas (the camera-relative remap is applied by the input
// layer before calling in, keeping the engine ignorant of the scene camera).
//
// Verifiable headlessly: drive spawn/move/rotate/hardDrop/tick and inspect
// board + state with no Three.js present.

import { Board } from "./board";
import type { Cell, ClearResult } from "./board";
import { Piece } from "./piece";
import { GameState } from "./state";
import {
  ACCEL_MS,
  CHARGE_PER_LINE,
  CYCLE_TIME_MS,
  DEATH_HEIGHT,
  DOUBLE_CLEAR_BONUS,
  HARD_DROP_POINTS,
  MIN_CYCLE_TIME_MS,
  POWER_SCORE_PER_CUBE,
  SOFT_DROP_FACTOR,
  SOFT_DROP_POINTS,
} from "../shared/constants";

export type LockEvent = {
  /** Cells the piece occupied when it locked (for lock-dust fx). */
  lockedCells: Cell[];
  /** Colour index 1..7 of the piece that locked. */
  colorIndex: number;
  /** Layer it locked at. */
  layer: number;
  clear: ClearResult;
  scoreGained: number;
  gameOver: boolean;
};

function shuffledBag(): number[] {
  const bag = [0, 1, 2, 3, 4, 5, 6];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = bag[i] ?? 0;
    bag[i] = bag[j] ?? 0;
    bag[j] = a;
  }
  return bag;
}

const EMPTY_CLEAR: ClearResult = { xColumns: 0, zRows: 0, lines: 0, cubes: 0 };
const EMPTY_LOCK: LockEvent = {
  lockedCells: [],
  colorIndex: 0,
  layer: 0,
  clear: EMPTY_CLEAR,
  scoreGained: 0,
  gameOver: false,
};

export class Engine {
  readonly board: Board = new Board();
  readonly state = new GameState();
  active: Piece | null = null;
  nextIndex: number;
  holdIndex: number | null = null;
  cycleTimeMs = CYCLE_TIME_MS;
  softDropping = false;
  /** Power-sweep meter [0..1]; fills on line clears, 1 = one sweep ready. */
  charge = 0;

  private bag: number[] = [];
  private fallAccumMs = 0;
  /** One hold per piece (standard Tetris). */
  private holdUsed = false;

  constructor() {
    this.nextIndex = this.drawFromBag();
  }

  private drawFromBag(): number {
    if (this.bag.length === 0) this.bag = shuffledBag();
    return this.bag.pop() ?? 0;
  }

  reset(): void {
    this.board.reset();
    this.state.reset();
    this.cycleTimeMs = CYCLE_TIME_MS;
    this.softDropping = false;
    this.fallAccumMs = 0;
    this.charge = 0;
    this.bag = [];
    this.active = null;
    this.holdIndex = null;
    this.holdUsed = false;
    this.nextIndex = this.drawFromBag();
  }

  startGame(): void {
    this.reset();
    this.state.status = "playing";
    this.spawnNext();
  }

  /** Spawn a specific piece; false = it can't fit (top-out). */
  private spawnSpecific(index: number): boolean {
    const piece = new Piece(index, this.board);
    if (this.board.collides(piece.cells())) {
      this.active = null;
      return false;
    }
    this.active = piece;
    this.fallAccumMs = 0;
    return true;
  }

  /** Spawn the queued piece and refill the queue from the bag. */
  private spawnNext(): boolean {
    const idx = this.nextIndex;
    this.nextIndex = this.drawFromBag();
    return this.spawnSpecific(idx);
  }

  /** Cross-arms / Hold key: swap the active piece with the held one (once per
   *  piece). Aborts if the incoming piece can't spawn. Returns whether it held. */
  hold(): boolean {
    if (this.state.status !== "playing" || !this.active || this.holdUsed) return false;
    const cur = this.active.index;
    const incoming = this.holdIndex === null ? this.nextIndex : this.holdIndex;
    const piece = new Piece(incoming, this.board);
    if (this.board.collides(piece.cells())) return false;
    if (this.holdIndex === null) this.nextIndex = this.drawFromBag();
    this.holdIndex = cur;
    this.active = piece;
    this.fallAccumMs = 0;
    this.holdUsed = true;
    return true;
  }

  canPower(): boolean {
    return this.state.status === "playing" && this.charge >= 1;
  }

  /** Spend a full charge to clear the lowest layer. Returns cubes removed. */
  power(): number {
    if (!this.canPower()) return 0;
    const removed = this.board.sweepLowestLayer();
    this.charge = 0;
    if (removed > 0) this.state.addScore(removed * POWER_SCORE_PER_CUBE);
    return removed;
  }

  // ---- player verbs (world-space; input layer applies camera correction) ----

  move(dx: number, dz: number): boolean {
    if (this.state.status !== "playing" || !this.active) return false;
    return this.active.move(this.board, dx, dz);
  }

  rotate(): boolean {
    if (this.state.status !== "playing" || !this.active) return false;
    return this.active.rotate(this.board);
  }

  setSoftDrop(on: boolean): void {
    this.softDropping = on;
  }

  hardDrop(): LockEvent | null {
    if (this.state.status !== "playing" || !this.active) return null;
    let fallen = 0;
    while (this.active.fall(this.board)) fallen += 1;
    this.state.addScore(fallen * HARD_DROP_POINTS);
    return this.lockActive();
  }

  // ---- gravity ----------------------------------------------------------------

  /** Advance gravity. `paused` (camera mid-swing) freezes the fall but keeps
   *  the game live. Returns a LockEvent on the frame a piece locks. */
  tick(dtMs: number, paused: boolean): LockEvent | null {
    if (this.state.status !== "playing" || !this.active || paused) return null;
    const interval = this.cycleTimeMs * (this.softDropping ? SOFT_DROP_FACTOR : 1);
    this.fallAccumMs += dtMs;
    while (this.fallAccumMs >= interval) {
      this.fallAccumMs -= interval;
      const moved = this.active.fall(this.board);
      if (moved) {
        if (this.softDropping) this.state.addScore(SOFT_DROP_POINTS);
      } else {
        return this.lockActive();
      }
    }
    return null;
  }

  private lockActive(): LockEvent {
    const piece = this.active;
    if (!piece) return EMPTY_LOCK;
    const colorIndex = piece.colorIndex;
    const lockedCells = piece.cells();
    const layer = this.board.lock(lockedCells, colorIndex);
    const clear = this.board.clearLayer(layer);

    let scoreGained = 0;
    if (clear.lines > 0) {
      scoreGained =
        clear.cubes * 10 + (clear.xColumns > 0 && clear.zRows > 0 ? DOUBLE_CLEAR_BONUS : 0);
      this.state.addScore(scoreGained);
      this.state.lines += clear.lines;
      this.cycleTimeMs = Math.max(MIN_CYCLE_TIME_MS, this.cycleTimeMs - ACCEL_MS * clear.lines);
      this.charge = Math.min(1, this.charge + clear.lines * CHARGE_PER_LINE);
    }

    this.softDropping = false;
    this.fallAccumMs = 0;
    this.active = null;

    let gameOver = layer >= DEATH_HEIGHT;
    if (!gameOver) {
      gameOver = !this.spawnNext();
      if (!gameOver) this.holdUsed = false; // a fresh piece may be held again
    }

    if (gameOver) {
      this.active = null;
      this.state.status = "collapsing"; // scene runs the cosmetic tumble
    }
    return { lockedCells, colorIndex, layer, clear, scoreGained, gameOver };
  }

  /** Catch-the-collapse rescue: settle the rubble, resume from a shorter
   *  stack. Returns true if it's still game over (couldn't even spawn). */
  resumeAfterCatch(): boolean {
    this.board.collapseDown();
    this.fallAccumMs = 0;
    this.softDropping = false;
    this.holdUsed = false;
    this.state.status = "playing";
    if (!this.spawnNext()) {
      this.state.status = "gameOver";
      return true;
    }
    return false;
  }

  // ---- read models for rendering ----------------------------------------------

  activeCells(): Cell[] {
    return this.active?.cells() ?? [];
  }

  /** Index of the active piece (0..6), or -1 if none. */
  activePieceIndex(): number {
    return this.active?.index ?? -1;
  }

  /** Where the active slab would land — drives the drop-ghost. */
  ghostCells(): Cell[] {
    return this.active?.landingCells(this.board) ?? [];
  }
}
