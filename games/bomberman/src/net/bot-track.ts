// Bots, as a guest draws them.
//
// A bot turns every BOT_MOVE_MS of sim time, moved or not, and the host
// writes each turn: the tile the bot took, and `nextMoveAt`, a stride after
// the turn. A guest takes every turn as one sample, stamped with the turn and
// standing on the tile the stride ends on — the SDK's recipe for grid movers.
// That draws each stride a stride early on the stamps' timeline, so the delay
// is a stride plus jitter: the body walks every stride evenly, turns on tile
// centres and never overshoots, and the clock's measured hold grows the delay
// on a route that needs it. Each bot keeps a clock of its own (one that joins
// mid-round turns out of step with the rest), relearnt when the host changes.
// The host draws its own bots from its sim instead (render/bot-stride).

import { Interpolator } from "@vibedgames/multiplayer";
import type { RemoteClock } from "@vibedgames/multiplayer";
import { BOT_MOVE_MS } from "../shared/constants";
import type { Dir } from "../shared/constants";
import { blendSamples, poseOf, readThrough, sameTile, standing, stepDir } from "./step-track";
import type { GridSample, GridTile, StepPose } from "./step-track";

/** The least delay behind a bot's turns: a stride, plus a good connection's jitter. */
export const TURN_DELAY_MS = BOT_MOVE_MS + 50;

/** A bot as a guest draws it, from the turns its host writes. */
export class TurnTrack {
  private readonly clock: RemoteClock;
  private readonly interp: Interpolator<GridSample>;
  private last: GridSample | null = null;

  /** `clock` is the bot's own, kept across rounds and relearnt when the host changes. */
  constructor(clock: RemoteClock) {
    this.clock = clock;
    this.interp = new Interpolator<GridSample>({
      clock: readThrough(clock),
      delayMs: TURN_DELAY_MS,
      lerp: blendSamples,
      maxExtrapolateMs: 0,
    });
  }

  /**
   * The bot's turn at `at` (sim time) left it on `tile`, facing `dir`;
   * `receivedAt` is when it arrived here (local time). The first turn seen,
   * or a jump past a neighbouring tile, places the bot. A placement's stamp
   * can be a turn still to come (a bot just spawned), so the clock learns
   * only from turns.
   */
  turn(tile: GridTile, at: number, dir: Dir, receivedAt = performance.now()): void {
    const { last } = this;
    const from = last && { col: last.x, row: last.y };
    if (!from || (!sameTile(from, tile) && !stepDir(from, tile))) {
      this.interp.clear();
      this.last = standing(tile, dir, Number.NEGATIVE_INFINITY);
      this.interp.push(at, this.last, receivedAt);
      return;
    }
    this.clock.observe(at, receivedAt);
    // Drawn, the stride that ends at this turn's tile ends at this turn.
    const arrived = sameTile(from, tile) ? last.arrived : at;
    const sample = standing(tile, dir, arrived);
    if (this.interp.push(at, sample, receivedAt)) {
      this.last = sample;
    }
  }

  /** The pose to draw at local time `localNow`. */
  sample(localNow: number): StepPose | undefined {
    const sample = this.interp.sample(localNow);
    return sample && poseOf(sample, this.interp.renderTime(localNow));
  }

  /** Forget where the bot is: the next turn places it (a new round). */
  clear(): void {
    this.interp.clear();
    this.last = null;
  }
}
