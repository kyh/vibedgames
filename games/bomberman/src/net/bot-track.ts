import { Interpolator } from "@vibedgames/multiplayer";
import type { RemoteClock } from "@vibedgames/multiplayer";
import { BOT_MOVE_MS } from "../shared/constants";
import type { Dir } from "../shared/constants";
import { blendSamples, poseOf, readThrough, sameTile, standing, stepDir } from "./step-track";
import type { GridSample, GridTile } from "./step-track";

/** The least delay behind a bot's turns: a stride, plus a good connection's jitter. */
export const TURN_DELAY_MS = BOT_MOVE_MS + 50;

/** A bot as a guest draws it, from the turns its host writes. */
export class TurnTrack {
  private readonly clock: RemoteClock;
  private readonly interp: Interpolator<GridSample>;
  private last: GridSample | null = null;

  /** `clock` is the bot's own, kept across rounds and relearnt whenever the turns' route changes. */
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
  turn(tile: GridTile, at: number, dir: Dir, receivedAt = performance.now()) {
    const { last } = this;
    const from = last && { col: last.x, row: last.y };

    if (!from || (!sameTile(from, tile) && !stepDir(from, tile))) {
      this.interp.clear();
      this.last = standing(tile, dir, Number.NEGATIVE_INFINITY);
      this.interp.push(at, this.last, receivedAt);

      return;
    }

    this.clock.observe(at, receivedAt);
    const arrived = sameTile(from, tile) ? last.arrived : at;
    const sample = standing(tile, dir, arrived);

    if (this.interp.push(at, sample, receivedAt)) {
      this.last = sample;
    }
  }

  /** The pose to draw at local time `localNow`. */
  sample(localNow: number) {
    const sample = this.interp.sample(localNow);

    return sample && poseOf(sample, this.interp.renderTime(localNow));
  }

  /** Forget where the bot is: the next turn places it (a new round). */
  clear() {
    this.interp.clear();
    this.last = null;
  }
}
