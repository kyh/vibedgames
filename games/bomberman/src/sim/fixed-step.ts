/**
 * Fixed steps for the host simulation, on the sim clock. Steps land on an
 * exact grid whatever the frame rate — a bot's 200 ms stride is four 50 ms
 * steps on a 60, 144 or 30 Hz display alike — and the sim clock already holds
 * still through a pause. After a stall only `maxBacklogMs` of steps catch up.
 */
export class FixedStep {
  private readonly stepMs: number;
  private readonly maxBacklogMs: number;
  private last: number | null = null;

  constructor(stepMs: number, maxBacklogMs: number) {
    this.stepMs = stepMs;
    this.maxBacklogMs = maxBacklogMs;
  }

  /**
   * The sim time of the oldest step due by `now`, taken, or null when none
   * is. A step not taken stays due: the next call that reaches it returns it.
   */
  next(now: number): number | null {
    if (this.last === null || now < this.last - this.maxBacklogMs) {
      // First step, or the clock was replaced (a promoted host adopts the room's).
      this.last = now - this.stepMs;
    } else if (now - this.last > this.maxBacklogMs) {
      this.last = now - this.maxBacklogMs;
    }
    if (now - this.last < this.stepMs) {
      return null;
    }
    this.last += this.stepMs;
    return this.last;
  }

  /** The sim times of every step due by `now`, oldest first. */
  due(now: number): number[] {
    const due: number[] = [];
    for (let at = this.next(now); at !== null; at = this.next(now)) {
      due.push(at);
    }
    return due;
  }

  /** Forget the grid; the next `due` starts a fresh one with a step at once. */
  reset(): void {
    this.last = null;
  }
}
