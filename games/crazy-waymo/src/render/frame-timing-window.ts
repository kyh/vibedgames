/** A wall-clock window: slow devices must not wait 120 slow frames to recover. */
export class FrameTimingWindow {
  private readonly frames: number[] = [];
  private elapsedMs = 0;

  reset(): void {
    this.frames.length = 0;
    this.elapsedMs = 0;
  }

  /** Returns sustained frame cost after roughly two seconds. A median alone
   * misses recurring stalls when most frames still hit vsync. Ignore the two
   * largest samples (one hitch duplicated by phone pairing), then include the
   * remaining elapsed cost. One compile/GC event cannot demote steady play. */
  sample(dt: number): number | null {
    if (!Number.isFinite(dt) || dt <= 0) return null;
    // Keep sustained slow frames. Bound a resumed tab/breakpoint to one sample;
    // outlier removal rejects it without making the governor blind below 10 FPS.
    const ms = Math.min(dt * 1000, 250);
    this.frames.push(ms);
    this.elapsedMs += ms;
    if (this.elapsedMs < 2000 || this.frames.length < 8) return null;
    const sorted = [...this.frames].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] ?? 1000 / 60;
    const retained = sorted.length - 2;
    let total = 0;
    for (let i = 0; i < retained; i++) total += sorted[i] ?? 0;
    const sustained = Math.max(median, total / retained);
    this.reset();
    return sustained;
  }
}
