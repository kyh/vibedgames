// The host's own bot, drawn exactly from its sim: each stride from the tile
// it left to the tile it took, over the BOT_MOVE_MS after the turn that took
// it. Guests draw bots from the host's turns instead (net/bot-track).

import { lerp } from "@vibedgames/multiplayer";
import type { SenderClock } from "@vibedgames/multiplayer";
import { BOT_MOVE_MS } from "../shared/constants";
import type { Dir } from "../shared/constants";
import { sameTile, stepDir, WALK_GRACE_MS } from "../net/step-track";
import type { GridTile, StepPose } from "../net/step-track";

export class BotStride {
  private readonly clock: SenderClock;
  private stride: { from: GridTile; to: GridTile; at: number; dir: Dir } | null = null;

  /** `clock` is the sim clock the bots turn on. */
  constructor(clock: SenderClock) {
    this.clock = clock;
  }

  /** The bot moved onto `tile` at its turn at `at` (sim time), facing `dir`. A jump places it. */
  turn(tile: GridTile, at: number, dir: Dir): void {
    const last = this.stride?.to;
    const from = last && stepDir(last, tile) ? last : tile;
    this.stride = { at, dir, from, to: tile };
  }

  /** The pose to draw at local time `localNow`: on time, mid-stride. */
  sample(localNow: number): StepPose | undefined {
    const { stride } = this;
    if (!stride) {
      return undefined;
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
  clear(): void {
    this.stride = null;
  }
}
