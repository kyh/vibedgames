// Traffic counters for the diagnostics readout.

/** Events per second over one-second windows, plus the mean size of the last window's events. */
export class Meter {
  rate = 0;
  meanSize = 0;
  private count = 0;
  private bytes = 0;
  private windowStart = Number.NaN;

  add(size = 0): void {
    this.roll();
    this.count += 1;
    this.bytes += size;
  }

  /** Close the window once a second has passed; a silent stream reads as zero, not as its last rate. */
  roll(): void {
    const now = performance.now();
    if (Number.isNaN(this.windowStart)) {
      this.windowStart = now;
      return;
    }
    const span = now - this.windowStart;
    if (span < 1000) {
      return;
    }
    this.rate = Math.round((this.count * 1000) / span);
    this.meanSize = this.count > 0 ? Math.round(this.bytes / this.count) : this.meanSize;
    this.count = 0;
    this.bytes = 0;
    this.windowStart = now;
  }
}
