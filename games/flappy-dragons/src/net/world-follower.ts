// Where the shared course is, on a guest. Free of Phaser so tools/net.test.mts
// can drive it headless.

import { RemoteClock } from "@vibedgames/multiplayer";

import { PIPE_SPEED } from "../shared/constants";

/**
 * A guest scroll this far from the host's is not drift but a different course
 * position (the first report after joining, a migration that went badly), and
 * is adopted in one frame. One trunk spacing.
 */
export const WORLD_SNAP_PX = 400;
/** Share of the remaining error folded in per second. */
const WORLD_CORRECT_GAIN = 2;
/**
 * Fastest fold (px/s) while the dragon flies: the pipes it is steering between
 * speed up or slow down by about a quarter at most, and never reverse.
 */
const WORLD_CORRECT_FLYING = 40;
/** Not flying (start screen, countdown, hover, crashed), a lagging course may hurry this much more. */
const WORLD_CATCH_UP = 3 * PIPE_SPEED;

/**
 * A guest's copy of the shared course scroll. The host advances it at
 * PIPE_SPEED on real time and reports `{ t, x }` a few times a second, stamped
 * with its own clock. Between reports the guest dead-reckons at PIPE_SPEED and
 * folds the remaining error in at a capped rate below PIPE_SPEED. Adopting each
 * report outright jumped the whole pipe field on every packet — backwards,
 * whenever the host's clock had lost time.
 */
export class WorldFollower {
  /** True when the last `advance` adopted the host's scroll outright. */
  snapped = false;
  private readonly clock = new RemoteClock();
  private reportT = Number.NaN;
  private reportX = 0;
  private synced = false;

  /** The host's report: its scroll `x` at its clock time `t`. A repeated stamp is ignored. */
  observe(t: number, x: number, receivedAt?: number): void {
    if (t === this.reportT) {
      return;
    }
    this.reportT = t;
    this.reportX = x;
    this.clock.observe(t, receivedAt);
  }

  /** A new host stamps with another machine's clock: dead-reckon until it reports. */
  reset(): void {
    this.clock.reset();
    this.reportT = Number.NaN;
  }

  /** Adopt the next report outright: a reseeded course starts somewhere else entirely. */
  resync(): void {
    this.synced = false;
  }

  /** `worldX` one frame of `stepMs` later. `flying` holds the correction to a gentle fold. */
  advance(worldX: number, stepMs: number, now: number, flying: boolean): number {
    const ahead = worldX + (PIPE_SPEED * stepMs) / 1000;
    this.snapped = false;
    if (!this.clock.synced) {
      // No report on this host's clock yet (just joined, or a handover):
      // keep scrolling; the first report lands outright if we never had one.
      return ahead;
    }
    const target = this.reportX + (PIPE_SPEED * (this.clock.now(now) - this.reportT)) / 1000;
    const error = target - ahead;
    if (!this.synced || Math.abs(error) > WORLD_SNAP_PX) {
      this.synced = true;
      this.snapped = true;
      return target;
    }
    const seconds = stepMs / 1000;
    // min(1, …): a long frame folds the error in, never past it.
    const fold = error * Math.min(1, WORLD_CORRECT_GAIN * seconds);
    const most = (flying ? WORLD_CORRECT_FLYING : WORLD_CATCH_UP) * seconds;
    // At most PIPE_SPEED back: the course can halt for a moment, never run backwards.
    const least = -(flying ? WORLD_CORRECT_FLYING : PIPE_SPEED) * seconds;
    return ahead + Math.min(most, Math.max(least, fold));
  }
}
