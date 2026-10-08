// The host's half of the time alignment in prediction.ts: per remote human
// body, the newest intent the sim has run and since when. Its row reports both
// as durations, so the guest can find the matching moment on its own clock.

/** Host side, per remote human body: the newest intent applied and since when (host sim ms). */
export class IntentAck {
  seq = 0;
  private appliedAt = 0;

  /** Record an intent applied in the step starting at `stepStartMs`; false for a stale sequence. */
  take(seq: number, stepStartMs: number): boolean {
    if (seq <= this.seq) {
      return false;
    }
    this.seq = seq;
    this.appliedAt = stepStartMs;
    return true;
  }

  /** How long the newest intent has been applied as of `nowMs` (whole ms). */
  age(nowMs: number): number {
    return this.seq === 0 ? 0 : Math.max(0, Math.round(nowMs - this.appliedAt));
  }
}
