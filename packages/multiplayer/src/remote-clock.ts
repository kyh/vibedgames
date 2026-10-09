/**
 * A remote sender's clock, mapped onto this client's — the timebase that
 * snapshot interpolation renders against. See `Interpolator`.
 */

const now = (): number => performance.now();

/** A new estimate this far from the applied one is a different clock (host migration, sender reload), adopted at once. */
const RESYNC_MS = 250;
/** Smaller revisions bend playback speed by at most this fraction instead of jumping. */
const SLEW = 0.1;
/** Width of one min-filter bucket, in receive time. */
const BUCKET_MS = 1000;

/**
 * The clock an `Interpolator` renders against: something that learns from
 * stamped arrivals (`observe`) and maps local time to the senders' time
 * (`now`). `RemoteClock` estimates one sender's clock; a client's
 * `serverClock` is the room's shared server time, with nothing to estimate.
 */
export interface SenderClock {
  /** True once `now` reads the senders' time rather than falling back to the local clock. */
  readonly synced: boolean;
  /** Learn from one stamped arrival; a shared clock with nothing to estimate omits it. */
  observe?: (sentAt: number, receivedAt: number) => void;
  now: (localNow?: number) => number;
  /** Forget the estimate (the sender restarted its clock). */
  reset?: () => void;
}

export interface RemoteClockOptions {
  /**
   * How long one fast arrival keeps defining the offset (ms). Longer rides out
   * more jitter; shorter adapts sooner when the route gets slower. Default 3000.
   */
  windowMs?: number;
}

/**
 * Maps a remote sender's timestamps onto this client's clock.
 *
 * Two machines' `performance.now()` share no epoch, so all a receiver can
 * measure is `receivedAt - sentAt`: clock skew plus that packet's one-way
 * latency. Latency only ever adds, so the smallest difference seen recently —
 * the packet that made the trip fastest — is the best estimate of the skew
 * plus the path's floor. A sliding-window minimum (not an all-time one) lets
 * it rise again after a route change; the offset actually used slews toward
 * the estimate, so a revision speeds or slows playback slightly instead of
 * jumping it.
 *
 * One clock per sender: share it across every entity that sender reports (a
 * host's world snapshot). Stamps in server time carry straight on through a
 * host change, so `relearn()` the clock then; the new host's route differs.
 */
export class RemoteClock implements SenderClock {
  private readonly windowMs: number;
  private readonly buckets: { start: number; min: number }[] = [];
  private target: number | null = null;
  private applied: number | null = null;
  private lastRead = 0;

  constructor(options: RemoteClockOptions = {}) {
    this.windowMs = options.windowMs ?? 3000;
  }

  /** True once at least one timestamp has been observed. */
  get synced(): boolean {
    return this.target !== null;
  }

  /** Record one arrival: the sender's stamp and when it reached us. */
  observe(sentAt: number, receivedAt: number = now()): void {
    const offset = receivedAt - sentAt;
    const head = this.buckets.at(-1);
    if (head !== undefined && receivedAt - head.start < BUCKET_MS) {
      head.min = Math.min(head.min, offset);
    } else {
      this.buckets.push({ min: offset, start: receivedAt });
      while (this.buckets.length > 1) {
        const [oldest] = this.buckets;
        if (oldest === undefined || receivedAt - (oldest.start + BUCKET_MS) <= this.windowMs) {
          break;
        }
        this.buckets.shift();
      }
    }
    let min = Number.POSITIVE_INFINITY;
    for (const bucket of this.buckets) {
      min = Math.min(min, bucket.min);
    }
    this.target = min;
  }

  /**
   * The sender's clock at local time `localNow`: the stamp a packet arriving
   * this instant over the fastest recent path would carry. Before any
   * observation it is the local clock.
   */
  now(localNow: number = now()): number {
    const { target } = this;
    if (target === null) {
      return localNow;
    }
    if (this.applied === null || Math.abs(target - this.applied) > RESYNC_MS) {
      this.applied = target;
    } else {
      const step = Math.max(0, localNow - this.lastRead) * SLEW;
      this.applied += Math.max(-step, Math.min(step, target - this.applied));
    }
    this.lastRead = localNow;
    return localNow - this.applied;
  }

  /**
   * The updates now take a different route on the same timebase — a new host
   * relaying server-time stamps, a reconnect: forget the old route's arrivals
   * and measure afresh. The applied offset stays and eases onto the new one,
   * so nothing rendered jumps, and a slower route takes over at once instead
   * of after the window.
   */
  relearn(): void {
    this.buckets.length = 0;
  }

  /** Forget everything — call when the sender's clock itself changes (a sender stamping its own clock reloaded). */
  reset(): void {
    this.buckets.length = 0;
    this.target = null;
    this.applied = null;
  }
}
