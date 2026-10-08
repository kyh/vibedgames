// A guest's own bombs, shown the frame the key goes down.
//
// The host owns every bomb, but waiting a round trip to see your own is the
// laggiest thing a guest can feel. The guest draws its bomb at once, under the
// id the host will give it (`bombId`: owner plus the guest's own counter), and
// treats it as solid. When the host's copy arrives under that id it takes
// over the same sprite with no second placement cue; when nothing arrives in
// time the host refused it, and the prediction goes. The host starts the fuse
// at the press (`fuseStart`), so the two copies burn down together.

import type { Bomb } from "../shared/constants";

/** Furthest back the host starts a guest's fuse (ms): a slow route's trip up. */
export const MAX_PRESS_AGE_MS = 250;

/**
 * When the host starts a guest's fuse: at the press, as the guest read the
 * clock every client shares. Never earlier than a slow trip ago, so a forged
 * stamp shaves at most that off a fuse, and never in the future.
 */
export const fuseStart = (pressedAt: number, now: number): number =>
  Math.min(now, Math.max(pressedAt, now - MAX_PRESS_AGE_MS));

/** How long a predicted bomb waits for the host's copy before it counts as refused (ms)... */
export const PREDICTION_TIMEOUT_MS = 600;
/** ...stretched to twice the slowest recent confirmation on a laggy route, up to this. */
const MAX_TIMEOUT_MS = 1500;
const CONFIRMS_KEPT = 8;

export class BombPrediction {
  private readonly pending = new Map<string, { bomb: Bomb; addedAt: number }>();
  /** How long the host took to confirm recent presses (ms). */
  private readonly confirms: number[] = [];

  /** How long a prediction is given before it counts as refused. */
  get timeoutMs(): number {
    const slowest = Math.max(0, ...this.confirms);
    return Math.min(MAX_TIMEOUT_MS, Math.max(PREDICTION_TIMEOUT_MS, slowest * 2));
  }

  /** `now` is local time (`performance.now()`), which the timeout runs on. */
  add(bomb: Bomb, now: number): void {
    this.pending.set(bomb.id, { addedAt: now, bomb });
  }

  /**
   * Retire the predictions the host has confirmed or ran out of time on.
   * True when one was refused: its ghost has to come off the board.
   */
  settle(confirmed: Readonly<Record<string, Bomb>>, now: number): boolean {
    let refused = false;
    const { timeoutMs } = this;
    for (const [id, { addedAt }] of this.pending) {
      if (confirmed[id]) {
        this.pending.delete(id);
        this.confirms.push(now - addedAt);
        if (this.confirms.length > CONFIRMS_KEPT) {
          this.confirms.shift();
        }
      } else if (now - addedAt >= timeoutMs) {
        this.pending.delete(id);
        refused = true;
      }
    }
    return refused;
  }

  /** The host's bombs plus the predictions it has not confirmed yet. */
  visible(confirmed: Record<string, Bomb>) {
    if (this.pending.size === 0) {
      return confirmed;
    }
    const out = { ...confirmed };
    for (const [id, { bomb }] of this.pending) {
      out[id] ??= bomb;
    }
    return out;
  }

  clear(): void {
    this.pending.clear();
  }
}
