import { Interpolator, lerp, RemoteClock } from "@vibedgames/multiplayer";
import type { SenderClock } from "@vibedgames/multiplayer";
import type { Dir } from "../shared/constants";

export interface GridTile {
  col: number;
  row: number;
}

/** Where a mover is drawn this frame. */
export interface StepPose {
  /** Grid position in tiles, fractional mid-step. */
  x: number;
  y: number;
  /** The tile the body mostly covers. */
  col: number;
  row: number;
  dir: Dir;
  moving: boolean;
}

/** Where a body was at a sample's stamp: on a tile, or part way along a step in a blend. */
export interface GridSample {
  x: number;
  y: number;
  dir: Dir;
  /** When the body last reached a tile by walking: the walk cycle runs on WALK_GRACE_MS past it. */
  arrived: number;
  /** True for a blend between two places; a sample on its own stands. */
  moving: boolean;
}

/** A rest between steps shorter than this keeps the walk cycle going. */
export const WALK_GRACE_MS = 80;

/** The least delay behind a player's clock: a heartbeat plus a good connection's jitter. */
export const STEP_DELAY_MS = 100;
const STAMP_SLACK_MS = 2;

export const sameTile = (a: GridTile, b: GridTile) => a.col === b.col && a.row === b.row;

export const stepDir = (from: GridTile, to: GridTile) => {
  const dc = to.col - from.col;
  const dr = to.row - from.row;

  if (Math.abs(dc) + Math.abs(dr) !== 1) {
    return null;
  }

  if (dc !== 0) {
    return dc > 0 ? "right" : "left";
  }

  return dr > 0 ? "down" : "up";
};

/**
 * Blend two samples. Consecutive samples are on one tile or two neighbouring
 * ones, so a blend that moves runs along a grid line and faces the way it goes.
 */
export const blendSamples = (a: GridSample, b: GridSample, k: number) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (dx === 0 && dy === 0) {
    return a;
  }

  let dir: Dir = dy > 0 ? "down" : "up";

  if (dx !== 0) {
    dir = dx > 0 ? "right" : "left";
  }

  return { arrived: a.arrived, dir, moving: true, x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
};

/** A sample standing on `tile`. */
export const standing = (tile: GridTile, dir: Dir, arrived: number) => ({
  arrived,
  dir,
  moving: false,
  x: tile.col,
  y: tile.row,
});

/**
 * `clock` as an Interpolator reads it: it renders on the clock's time and
 * measured hold, and never teaches it. The owner teaches it the stamps that
 * are send times, since a sample stamped where a step ends is not one.
 */
export const readThrough: (clock: RemoteClock) => SenderClock = (clock) => ({
  hold: (localNow, floor) => clock.hold(localNow, floor),
  now: (localNow) => clock.now(localNow),
  get synced() {
    return clock.synced;
  },
});

/** The pose of `sample`, drawn at `renderAt` on the stamps' clock. */
export const poseOf = (sample: GridSample, renderAt: number) => ({
  col: Math.round(sample.x),
  dir: sample.dir,
  moving: sample.moving || renderAt - sample.arrived < WALK_GRACE_MS,
  row: Math.round(sample.y),
  x: sample.x,
  y: sample.y,
});

interface Stride {
  from: GridTile;
  to: GridTile;
  at: number;
  ms: number;
  dir: Dir;
  arrived: number;
}

export class StepTrack {
  private readonly clock = new RemoteClock();
  private readonly interp = new Interpolator<GridSample>({
    clock: readThrough(this.clock),
    delayMs: STEP_DELAY_MS,
    lerp: blendSamples,
    maxExtrapolateMs: 0,
  });
  private stride: Stride | null = null;
  private beatAt = Number.NEGATIVE_INFINITY;

  /** The newest tile reported, undelayed. */
  get latest() {
    return this.stride?.to;
  }

  /**
   * A step onto `to` that left the newest tile at `startedAt` (the sender's
   * clock) and lasts `strideMs`, arriving here at local time `receivedAt`.
   * A spawn (a zero stride), or a step that does not start from the newest
   * tile — a respawn, a teleport, a stamp that went backwards — places the
   * body there instead.
   */
  step(to: GridTile, startedAt: number, strideMs: number, receivedAt = performance.now()) {
    this.clock.observe(startedAt, receivedAt);
    const last = this.stride;
    const dir = last ? stepDir(last.to, to) : null;

    if (!last || !dir || !(strideMs > 0) || startedAt < last.at + last.ms - STAMP_SLACK_MS) {
      this.place(to, startedAt, last?.dir ?? "down", receivedAt);

      return;
    }

    const end = startedAt + strideMs;
    this.stride = { arrived: end, at: startedAt, dir, from: last.to, ms: strideMs, to };

    if (startedAt > last.at + last.ms) {
      this.interp.push(startedAt, standing(last.to, last.dir, last.arrived), receivedAt);
    }

    this.interp.push(end, standing(to, dir, end), receivedAt);
  }

  /** A heartbeat stamped `at` on the sender's clock: a body at rest still stands there. */
  beat(at: number, receivedAt = performance.now()) {
    if (at <= this.beatAt) {
      return;
    }

    this.beatAt = at;
    this.clock.observe(at, receivedAt);
    const { stride } = this;

    if (stride && at > stride.at + stride.ms) {
      this.interp.push(at, standing(stride.to, stride.dir, stride.arrived), receivedAt);
    }
  }

  /** The pose to draw at local time `localNow`. */
  sample(localNow: number) {
    const sample = this.interp.sample(localNow);

    return sample && poseOf(sample, this.interp.renderTime(localNow));
  }

  /** Forget where the body is: the next step places it (a new round respawns everyone). */
  clear() {
    this.interp.clear();
    this.stride = null;
  }

  /**
   * Our own connection came back: this player's messages now take another
   * route here. The clock measures it from the next arrival and eases onto
   * it; timed by the old route's quicker trips, a slower one would run render
   * time past the body's newest sample for seconds.
   */
  relearn() {
    this.clock.relearn();
  }

  private place(to: GridTile, at: number, dir: Dir, receivedAt: number) {
    const arrived = Number.NEGATIVE_INFINITY;
    this.interp.clear();
    this.stride = { arrived, at, dir, from: to, ms: 0, to };
    this.interp.push(at, standing(to, dir, arrived), receivedAt);
  }
}
