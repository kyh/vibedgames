export type FrameDecision =
  | { readonly kind: "skip" }
  | { readonly kind: "draw" }
  | {
      readonly kind: "advance";
      /** Actual time between accepted frames; the caller retains its simulation clamp. */
      readonly dt: number;
      /** Paired phone samples preserve both elapsed time and the governor's sample count. */
      readonly timing: { readonly dt: number; readonly samples: 1 | 2 } | null;
    };

type Clock = { last: number; due: number; pendingMs: number | null };

const INTERVAL_MS = 1000 / 60;
// Browser timestamps can be rounded to 0.1 ms and jitter slightly around
// vsync. Missing a deadline by that much must not defer a whole refresh.
// This bounded tolerance never shifts the absolute 60 Hz deadline grid.
const ROUNDING_MS = 0.5;

/** Cap phone rendering at 60 Hz without accumulating drift or catching up missed draws.
 * A 90 Hz display necessarily alternates 11/22 ms between accepted frames. Pair
 * those governor samples so its median sees 60 FPS, while gameplay gets real dt.
 * Paused resize draws never advance gameplay or contribute performance samples. */
export class FramePacer {
  private clock: Clock | null = null;
  private paused = false;
  private hidden = false;
  private drawPending = false;

  constructor(private readonly cadence: "display" | "60hz") {}

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.clock = null;
    this.invalidate();
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.clock = null;
    this.invalidate();
  }

  invalidate(): void {
    this.drawPending = true;
  }

  next(now: number): FrameDecision {
    if (this.hidden || !Number.isFinite(now) || now < 0) return { kind: "skip" };
    if (this.paused) return this.redraw();
    const clock = this.clock;
    if (!clock || now < clock.last) {
      this.clock = { last: now, due: now + INTERVAL_MS, pendingMs: null };
      this.drawPending = false;
      return { kind: "advance", dt: 0, timing: null };
    }
    if (now === clock.last || (this.cadence === "60hz" && now + ROUNDING_MS < clock.due)) {
      return this.redraw();
    }
    const elapsedMs = now - clock.last;
    clock.last = now;
    this.drawPending = false;
    if (this.cadence === "display") {
      return {
        kind: "advance",
        dt: elapsedMs / 1000,
        timing: { dt: elapsedMs / 1000, samples: 1 },
      };
    }
    // Advance the original deadline, not `now + interval`: 90 Hz and jitter
    // would otherwise lose time every time a deadline falls between callbacks.
    const intervals = Math.floor((now + ROUNDING_MS - clock.due) / INTERVAL_MS) + 1;
    clock.due += intervals * INTERVAL_MS;
    const pending = clock.pendingMs;
    clock.pendingMs = pending === null ? elapsedMs : null;
    return {
      kind: "advance",
      dt: elapsedMs / 1000,
      timing: pending === null ? null : { dt: (pending + elapsedMs) / 2000, samples: 2 },
    };
  }

  private redraw(): FrameDecision {
    if (!this.drawPending) return { kind: "skip" };
    this.drawPending = false;
    return { kind: "draw" };
  }
}
