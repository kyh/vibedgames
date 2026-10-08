// Remote grid movers, drawn from the sender's own step timing.
//
// A grid mover's state is a run of committed steps: at `startedAt` on the
// room's server clock it leaves one tile and `strideMs` later it stands on the
// next. Each step is kept as two waypoints and the body is drawn a fixed delay
// behind its sender's clock, so it moves on the sender's exact cadence however
// the packets bunch. That clock is the sender's own `RemoteClock`, which
// learns from every step's arrival how long the sender's relay takes, so the
// delay only has to cover jitter, however far the sender is from the server.
// Consecutive waypoints are at most one tile apart, so a body never cuts a
// corner, and nothing is extrapolated past the newest tile.
//
// The package's `Interpolator` can draw grid steps too, but only a whole stride
// plus jitter behind: a plain pose stream says where a step ends only when the
// next one starts. A step here carries its own stride, so it is drawn from the
// moment it starts, just the render delay behind.

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

interface Waypoint extends GridTile {
  t: number;
  dir: Dir;
  /** Where a step ends, as opposed to where a rest begins. */
  arrival: boolean;
}

export interface StepTrackOptions {
  /**
   * The sender's clock as this client reads it: its own `RemoteClock`, shared
   * by every mover that sender reports, or the sim clock for a host drawing its
   * own bots.
   */
  clock: SenderClock;
  /** How far behind that clock to draw (ms) — it covers arrival jitter. */
  delayMs: number;
}

/** A rest between steps shorter than this keeps the walk cycle going. */
export const WALK_GRACE_MS = 80;
/** Furthest the playhead may trail the render clock before it skips ahead. */
const MAX_LAG_MS = 600;
/** A late step replays at up to this much over real time while it catches up... */
const MAX_CATCH_UP = 0.5;
/** ...reached when the playhead trails by this much. */
const CATCH_UP_MS = 400;
/** No frame drawn for this long (a hidden tab): resume at the render clock, don't replay. */
const STALE_MS = 500;
/** Rounded stamps can land a millisecond either side of the previous arrival. */
const STAMP_SLACK_MS = 2;
const CAPACITY = 32;

export const stepDir = (from: GridTile, to: GridTile): Dir | null => {
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

export class StepTrack {
  private readonly clock: SenderClock;
  private readonly delayMs: number;
  private readonly points: Waypoint[] = [];
  /** The moment being drawn, on the stamps' clock. Trails the render clock only while a late step catches up. */
  private playAt: number | null = null;
  private sampledAt: number | null = null;

  constructor(options: StepTrackOptions) {
    this.clock = options.clock;
    this.delayMs = options.delayMs;
  }

  /** The newest tile reported, undelayed. */
  get latest(): GridTile | undefined {
    const last = this.points.at(-1);
    return last && { col: last.col, row: last.row };
  }

  /** Stand on `tile` without walking there: first sight, spawn, teleport. */
  snap(tile: GridTile, dir: Dir = "down"): void {
    this.points.length = 0;
    this.points.push({
      arrival: false,
      col: tile.col,
      dir,
      row: tile.row,
      t: Number.NEGATIVE_INFINITY,
    });
    this.playAt = null;
  }

  /**
   * A step onto `to` that left the newest tile at `startedAt` (the stamps'
   * clock) and lasts `strideMs`, arriving here at local time `receivedAt`.
   * Anything that does not start from the newest tile — a respawn, a teleport,
   * a stamp that went backwards — snaps instead.
   */
  step(to: GridTile, startedAt: number, strideMs: number, receivedAt = performance.now()): void {
    if (Number.isFinite(startedAt)) {
      // Every arrival, a snap's included, teaches the sender's clock its relay.
      this.clock.observe?.(startedAt, receivedAt);
    }
    const last = this.points.at(-1);
    const dir = last ? stepDir(last, to) : null;
    if (
      !last ||
      !dir ||
      !(strideMs > 0) ||
      !Number.isFinite(startedAt) ||
      startedAt < last.t - STAMP_SLACK_MS
    ) {
      this.snap(to, dir ?? last?.dir);
      return;
    }
    const start = Math.max(startedAt, last.t);
    if (start > last.t) {
      this.points.push({ ...last, arrival: false, t: start });
    }
    this.points.push({ arrival: true, col: to.col, dir, row: to.row, t: start + strideMs });
    // A step that set off before the playhead came in late, and the body has
    // been waiting on the tile it leaves: walk it from the start and catch up,
    // rather than jump into the middle of it.
    if (this.playAt !== null && this.playAt > start) {
      this.playAt = start;
    }
    while (this.points.length > CAPACITY) {
      this.points.shift();
    }
  }

  /** The pose to draw at local time `localNow`; advances the playhead. */
  sample(localNow: number): StepPose | undefined {
    const target = this.clock.now(localNow) - this.delayMs;
    const { playAt, sampledAt } = this;
    if (
      playAt === null ||
      sampledAt === null ||
      localNow - sampledAt > STALE_MS ||
      playAt - target > MAX_LAG_MS
    ) {
      this.playAt = target;
    } else {
      const lag = target - playAt;
      const rate = 1 + Math.min(MAX_CATCH_UP, Math.max(0, lag) / CATCH_UP_MS);
      const advanced = Math.min(target, playAt + Math.max(0, localNow - sampledAt) * rate);
      // Never backwards: a clock estimate that slews back holds the body instead.
      this.playAt = Math.max(playAt, advanced, target - MAX_LAG_MS);
    }
    this.sampledAt = localNow;
    return this.poseAt(this.playAt);
  }

  private poseAt(at: number): StepPose | undefined {
    const { points } = this;
    while (points.length > 1 && (points[1]?.t ?? Number.POSITIVE_INFINITY) <= at) {
      points.shift();
    }
    const [a, b] = points;
    if (!a) {
      return undefined;
    }
    if (!b || at <= a.t || (a.col === b.col && a.row === b.row)) {
      return {
        col: a.col,
        dir: a.dir,
        moving: a.arrival && at - a.t < WALK_GRACE_MS,
        row: a.row,
        x: a.col,
        y: a.row,
      };
    }
    const k = (at - a.t) / (b.t - a.t);
    const covered = k < 0.5 ? a : b;
    return {
      col: covered.col,
      dir: b.dir,
      moving: true,
      row: covered.row,
      x: a.col + (b.col - a.col) * k,
      y: a.row + (b.row - a.row) * k,
    };
  }
}
