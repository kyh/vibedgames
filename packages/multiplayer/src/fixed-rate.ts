/**
 * A steady send clock driven by a variable frame loop.
 *
 * The obvious throttle — `acc += dt; if (acc >= 1/hz) { acc = 0; send(); }` —
 * throws away the remainder every time it fires. At 60 fps a "20 Hz" clock
 * then fires every 4th frame and drifts down to ~15 Hz, and a "15 Hz" one
 * alternates 67 / 83 ms gaps. Receivers see that unevenness as stutter. This
 * keeps the remainder, so sends land on an exact cadence averaged over frames,
 * and drops (rather than bursts out) a backlog after a stall.
 *
 * ```ts
 * const net = new FixedRate(20);
 * // each frame:
 * if (net.due(deltaMs)) client.updateMyState({ t: Math.round(performance.now()), x, y });
 * ```
 */
export class FixedRate {
  readonly intervalMs: number;
  private acc = 0;

  constructor(hz: number) {
    if (!(hz > 0) || !Number.isFinite(hz)) {
      throw new RangeError(`FixedRate needs a positive finite rate, got ${hz}`);
    }
    this.intervalMs = 1000 / hz;
  }

  /** Advance the clock by `elapsedMs`; true when a tick is due this frame. */
  due(elapsedMs: number): boolean {
    if (elapsedMs > 0) {
      this.acc += elapsedMs;
    }
    if (this.acc < this.intervalMs) {
      return false;
    }
    this.acc -= this.intervalMs;
    // Still a whole interval behind after firing: the loop stalled (hidden
    // tab, long GC). One tick covers it — a burst of stale sends would only
    // queue up behind each other on the socket.
    if (this.acc >= this.intervalMs) {
      this.acc %= this.intervalMs;
    }
    return true;
  }

  /** Restart the phase so the next tick is a full interval away. */
  reset(): void {
    this.acc = 0;
  }
}
