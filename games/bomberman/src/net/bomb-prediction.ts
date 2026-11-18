import type { Bomb } from "../shared/constants";

/** Furthest back the host starts a guest's fuse (ms): a slow route's trip up. */
export const MAX_PRESS_AGE_MS = 250;

/**
 * When the host starts a guest's fuse: at the press, as the guest read the
 * clock every client shares. Never earlier than a slow trip ago, so a forged
 * stamp shaves at most that off a fuse, and never in the future.
 */
export const fuseStart = (pressedAt: number, now: number) =>
  Math.min(now, Math.max(pressedAt, now - MAX_PRESS_AGE_MS));

/** How long a predicted bomb waits for the host's copy before it counts as refused (ms)... */
export const PREDICTION_TIMEOUT_MS = 600;
const MAX_TIMEOUT_MS = 1500;
const CONFIRMS_KEPT = 8;

export class BombPrediction {
  private readonly pending = new Map<string, { bomb: Bomb; addedAt: number }>();
  private readonly confirms: number[] = [];

  /** How long a prediction is given before it counts as refused. */
  get timeoutMs() {
    const slowest = Math.max(0, ...this.confirms);

    return Math.min(MAX_TIMEOUT_MS, Math.max(PREDICTION_TIMEOUT_MS, slowest * 2));
  }

  /** `now` is local time (`performance.now()`), which the timeout runs on. */
  add(bomb: Bomb, now: number) {
    this.pending.set(bomb.id, { addedAt: now, bomb });
  }

  /**
   * Retire the predictions the host has confirmed or ran out of time on.
   * True when one was refused: its ghost has to come off the board.
   */
  settle(confirmed: Readonly<Record<string, Bomb>>, now: number) {
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

  clear() {
    this.pending.clear();
  }
}
