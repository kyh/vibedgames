import { lerp } from "@vibedgames/multiplayer";
import type { SenderClock } from "@vibedgames/multiplayer";
import { BOT_MOVE_MS } from "../shared/constants";
import type { Dir } from "../shared/constants";
import { sameTile, stepDir, WALK_GRACE_MS } from "../net/step-track";
import type { GridTile } from "../net/step-track";

export class BotStride {
  private readonly clock: SenderClock;
  private stride: { from: GridTile; to: GridTile; at: number; dir: Dir } | null = null;

  /** `clock` is the sim clock the bots turn on. */
  constructor(clock: SenderClock) {
    this.clock = clock;
  }

  /** The bot moved onto `tile` at its turn at `at` (sim time), facing `dir`. A jump places it. */
  turn(tile: GridTile, at: number, dir: Dir) {
    const last = this.stride?.to;
    const from = last && stepDir(last, tile) ? last : tile;
    this.stride = { at, dir, from, to: tile };
  }

  /** The pose to draw at local time `localNow`: on time, mid-stride. */
  sample(localNow: number) {
    const { stride } = this;

    if (!stride) {
      return null;
    }

    const { at, dir, from, to } = stride;
    const into = this.clock.now(localNow) - at;
    const k = Math.min(1, Math.max(0, into / BOT_MOVE_MS));
    const x = lerp(from.col, to.col, k);
    const y = lerp(from.row, to.row, k);

    return {
      col: Math.round(x),
      dir,
      moving: !sameTile(from, to) && into < BOT_MOVE_MS + WALK_GRACE_MS,
      row: Math.round(y),
      x,
      y,
    };
  }

  /** Forget where the bot is: the next turn places it. */
  clear() {
    this.stride = null;
  }
}
