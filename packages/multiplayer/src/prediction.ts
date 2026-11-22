const now = () => performance.now();

export interface ReconcilerOptions {
  /** Errors at or under this distance are left alone (world units): float noise, harmless sim drift. */
  deadZone: number;
  /** Errors at or over this distance are applied in one frame — the jerk is the feedback (knockback, a missed collision). */
  snapDistance: number;
  /** Time constant for easing out a smaller error (ms). Default 100. */
  smoothingMs?: number;
  /** Predicted trajectory kept (ms). Must exceed the worst round trip plus one snapshot interval. Default 1000. */
  historyMs?: number;
}

export interface Correction {
  x: number;
  y: number;
}

export class Reconciler {
  private readonly deadZone: number;
  private readonly snapDistance: number;
  private readonly smoothingMs: number;
  private readonly historyMs: number;
  private readonly ts: number[] = [];
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private pendingX = 0;
  private pendingY = 0;
  private snapPending = false;

  constructor(options: ReconcilerOptions) {
    this.deadZone = options.deadZone;
    this.snapDistance = options.snapDistance;
    this.smoothingMs = Math.max(1, options.smoothingMs ?? 100);
    this.historyMs = options.historyMs ?? 1000;
  }

  /** The error still being eased out, for diagnostics. */
  get pending() {
    return { x: this.pendingX, y: this.pendingY };
  }

  /**
   * Measure an authoritative position for the predicted body against the
   * recent trajectory. Sets the error that `step` eases out — replacing any
   * not yet applied, since the trajectory already carries what was applied.
   * Ignored until `step` has recorded at least one position.
   *
   * `at` is the local time (the clock `step` records with) that the host's
   * copy corresponds to — the moment the input it last applied was sent here,
   * plus how long the host has applied it. With it the comparison is exact.
   * Without it the host's position is matched to the nearest point on the
   * recent path, which needs no extra wire data but cannot see an error
   * along the direction of travel (a host copy running behind looks like
   * latency) until the body stops and the path collapses to a point.
   */
  reconcile(x: number, y: number, at?: number) {
    if (this.ts.length === 0) {
      return;
    }

    const [px, py] = (at === undefined ? undefined : this.positionAt(at)) ?? this.nearest(x, y);
    const distance = Math.hypot(x - px, y - py);

    if (distance <= this.deadZone) {
      this.pendingX = 0;
      this.pendingY = 0;
      this.snapPending = false;

      return;
    }

    this.pendingX = x - px;
    this.pendingY = y - py;
    this.snapPending = distance >= this.snapDistance;
  }

  /**
   * Record where the local sim put the body this frame and return the slice
   * of the pending error to add to it now. The returned offset is already
   * folded into the recorded trajectory — apply it to the body, never twice.
   */
  step(x: number, y: number, elapsedMs: number, at: number = now()) {
    let cx = 0;
    let cy = 0;

    if (this.pendingX !== 0 || this.pendingY !== 0) {
      const k = this.snapPending ? 1 : 1 - Math.exp(-Math.max(0, elapsedMs) / this.smoothingMs);
      cx = this.pendingX * k;
      cy = this.pendingY * k;
      this.pendingX -= cx;
      this.pendingY -= cy;
      this.snapPending = false;

      if (Math.abs(this.pendingX) < 1e-9 && Math.abs(this.pendingY) < 1e-9) {
        this.pendingX = 0;
        this.pendingY = 0;
      }

      for (let i = 0; i < this.ts.length; i += 1) {
        this.xs[i] = (this.xs[i] ?? 0) + cx;
        this.ys[i] = (this.ys[i] ?? 0) + cy;
      }
    }

    this.ts.push(at);
    this.xs.push(x + cx);
    this.ys.push(y + cy);

    while (this.ts.length > 2 && at - (this.ts[0] ?? at) > this.historyMs) {
      this.ts.shift();
      this.xs.shift();
      this.ys.shift();
    }

    return { x: cx, y: cy };
  }

  private positionAt(at: number) {
    const n = this.ts.length;
    const newest = this.ts[n - 1];

    if (newest !== undefined && at >= newest) {
      return [this.xs[n - 1] ?? 0, this.ys[n - 1] ?? 0] satisfies [number, number] | undefined;
    }

    for (let i = n - 2; i >= 0; i -= 1) {
      const t0 = this.ts[i] ?? 0;

      if (t0 <= at) {
        const t1 = this.ts[i + 1] ?? t0;
        const k = t1 > t0 ? (at - t0) / (t1 - t0) : 0;
        const x0 = this.xs[i] ?? 0;
        const y0 = this.ys[i] ?? 0;

        return [
          x0 + ((this.xs[i + 1] ?? x0) - x0) * k,
          y0 + ((this.ys[i + 1] ?? y0) - y0) * k,
        ] satisfies [number, number] | undefined;
      }
    }

    return undefined satisfies [number, number] | undefined;
  }

  private nearest(x: number, y: number) {
    let bestD2 = Number.POSITIVE_INFINITY;
    let best: [number, number] = [x, y];

    for (let i = 0; i < this.ts.length; i += 1) {
      const ax = this.xs[i] ?? 0;
      const ay = this.ys[i] ?? 0;
      const sx = (this.xs[i + 1] ?? ax) - ax;
      const sy = (this.ys[i + 1] ?? ay) - ay;
      const len2 = sx * sx + sy * sy;
      const along = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy) / len2)) : 0;
      const px = ax + sx * along;
      const py = ay + sy * along;
      const d2 = (x - px) ** 2 + (y - py) ** 2;

      if (d2 < bestD2) {
        bestD2 = d2;
        best = [px, py];
      }
    }

    return best;
  }

  /** Forget the trajectory and any pending error — after a teleport, respawn or new round. */
  clear() {
    this.ts.length = 0;
    this.xs.length = 0;
    this.ys.length = 0;
    this.pendingX = 0;
    this.pendingY = 0;
    this.snapPending = false;
  }
}
