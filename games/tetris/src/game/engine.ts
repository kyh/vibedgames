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

export interface LockEvent {
  /** Cells the piece occupied when it locked (for lock-dust fx). */
  lockedCells: Cell[];
  /** Colour index 1..7 of the piece that locked. */
  colorIndex: number;
  /** Layer it locked at. */
  layer: number;
  clear: ClearResult;
  gameOver: boolean;
}

const seededRandom = (seed: number) => {
  /* oxlint-disable no-bitwise -- mulberry32 IS its xor-shifts and uint32 wraps */
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  /* oxlint-enable no-bitwise */
};

const shuffledBag = (random: () => number) => {
  const bag = [0, 1, 2, 3, 4, 5, 6];

  for (let i = bag.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = bag[i] ?? 0;
    bag[i] = bag[j] ?? 0;
    bag[j] = a;
  }

  return bag;
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
  private random: () => number = Math.random;
  private fallAccumMs = 0;
  private holdUsed = false;

  constructor() {
    this.nextIndex = this.drawFromBag();
  }

  private drawFromBag() {
    if (this.bag.length === 0) {
      this.bag = shuffledBag(this.random);
    }

    return this.bag.pop() ?? 0;
  }

  /** Deal from a seeded sequence from the next reset on. */
  seed(seed: number) {
    this.random = seededRandom(seed);
  }

  reset() {
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

  startGame() {
    this.reset();
    this.state.status = "playing";
    this.spawnNext();
  }

  private spawnSpecific(index: number) {
    const piece = new Piece(index, this.board);

    if (this.board.collides(piece.cells())) {
      this.active = null;

      return false;
    }

    this.active = piece;
    this.fallAccumMs = 0;

    return true;
  }

  private spawnNext() {
    const idx = this.nextIndex;
    this.nextIndex = this.drawFromBag();

    return this.spawnSpecific(idx);
  }

  /** Cross-arms / Hold key: swap the active piece with the held one (once per
   *  piece). Aborts if the incoming piece can't spawn. Returns whether it held. */
  hold() {
    if (this.state.status !== "playing" || !this.active || this.holdUsed) {
      return false;
    }

    const cur = this.active.index;
    const incoming = this.holdIndex === null ? this.nextIndex : this.holdIndex;
    const piece = new Piece(incoming, this.board);

    if (this.board.collides(piece.cells())) {
      return false;
    }

    if (this.holdIndex === null) {
      this.nextIndex = this.drawFromBag();
    }

    this.holdIndex = cur;
    this.active = piece;
    this.fallAccumMs = 0;
    this.holdUsed = true;

    return true;
  }

  canPower() {
    return this.state.status === "playing" && this.charge >= 1;
  }

  /** Spend a full charge to clear the lowest layer. Returns cubes removed. */
  power() {
    if (!this.canPower()) {
      return 0;
    }

    const removed = this.board.sweepLowestLayer();
    this.charge = 0;

    if (removed > 0) {
      this.state.addScore(removed * POWER_SCORE_PER_CUBE);
    }

    return removed;
  }

  move(dx: number, dz: number) {
    if (this.state.status !== "playing" || !this.active) {
      return false;
    }

    return this.active.move(this.board, dx, dz);
  }

  rotate() {
    if (this.state.status !== "playing" || !this.active) {
      return false;
    }

    return this.active.rotate(this.board);
  }

  setSoftDrop(on: boolean) {
    this.softDropping = on;
  }

  hardDrop() {
    if (this.state.status !== "playing" || !this.active) {
      return null;
    }

    let fallen = 0;

    while (this.active.fall(this.board)) {
      fallen += 1;
    }

    this.state.addScore(fallen * HARD_DROP_POINTS);

    return this.lockActive(this.active);
  }

  /** Advance gravity. `paused` (camera mid-swing) freezes the fall but keeps
   *  the game live. Returns a LockEvent on the frame a piece locks. */
  tick(dtMs: number, paused: boolean) {
    if (this.state.status !== "playing" || !this.active || paused) {
      return null;
    }

    const interval = this.cycleTimeMs * (this.softDropping ? SOFT_DROP_FACTOR : 1);
    this.fallAccumMs += dtMs;

    while (this.fallAccumMs >= interval) {
      this.fallAccumMs -= interval;
      const moved = this.active.fall(this.board);

      if (moved) {
        if (this.softDropping) {
          this.state.addScore(SOFT_DROP_POINTS);
        }
      } else {
        return this.lockActive(this.active);
      }
    }

    return null;
  }

  private lockActive(piece: Piece) {
    const { colorIndex } = piece;
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

      if (!gameOver) {
        this.holdUsed = false;
      }
    }

    if (gameOver) {
      this.active = null;
      this.state.status = "collapsing";
    }

    return { clear, colorIndex, gameOver, layer, lockedCells };
  }

  /** Catch-the-collapse rescue: settle the rubble, resume from a shorter
   *  stack. Returns true if it's still game over (couldn't even spawn). */
  resumeAfterCatch() {
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

  /** Whether this piece has spent its one hold; a fresh spawn re-arms it. */
  get holdSpent() {
    return this.holdUsed;
  }

  activeCells() {
    return this.active?.cells() ?? [];
  }

  /** Index of the active piece (0..6), or -1 if none. */
  activePieceIndex() {
    return this.active?.index ?? -1;
  }

  /** Where the active slab would land — drives the drop-ghost. */
  ghostCells() {
    return this.active?.landingCells(this.board) ?? [];
  }
}
