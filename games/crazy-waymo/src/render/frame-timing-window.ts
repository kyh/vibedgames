/** A wall-clock window: slow devices must not wait 120 slow frames to recover. */
export class FrameTimingWindow {
  private readonly frames: number[] = [];
  private elapsedMs = 0;

  reset(): void {
    this.frames.length = 0;
    this.elapsedMs = 0;
  }

  /** Returns a median after roughly two seconds, with enough samples for outliers. */
  sample(dt: number): number | null {
    if (!Number.isFinite(dt) || dt <= 0) return null;
    // Keep sustained slow frames. Bound a resumed tab/breakpoint to one sample;
    // the median will reject it without making the governor blind below 10 FPS.
    const ms = Math.min(dt * 1000, 250);
    this.frames.push(ms);
    this.elapsedMs += ms;
    if (this.elapsedMs < 2000 || this.frames.length < 8) return null;
    const sorted = [...this.frames].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] ?? 1000 / 60;
    this.reset();
    return median;
  }
}
