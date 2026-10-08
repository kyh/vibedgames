// The clock a guest's mirror runs on. Every host stamps its frames with the
// room's server time; a frame can only be drawn once it has made the
// host → server → guest trip, so the mirror reads server time less that trip.
import type { SenderClock } from "@vibedgames/multiplayer";

/** Trips are kept as the fastest per this much receive time, over a window of a few. */
const TRIP_BUCKET_MS = 1000;
const TRIP_WINDOW_MS = 3000;
/** A trip outside this range is a clock not yet synced on one end, not a measurement (ms). */
const MIN_TRIP_MS = -500;
const MAX_TRIP_MS = 5000;
/** A new trip estimate this far from the applied one is taken at once (ms)… */
const TRIP_RESYNC_MS = 250;
/** …and a nearer one eased in, bending playback speed by at most this fraction. */
const TRIP_SLEW = 0.1;

/**
 * The host's time as of the newest frame's arrival, on the room's server
 * clock: server time minus the host → server → guest trip. The trip is the
 * fastest of the last few seconds (latency only ever adds), so jitter shows as
 * frames arriving late against this clock, never early, and the delay bodies
 * render behind it covers that jitter alone — not the whole trip, which is
 * what a fixed delay behind raw server time would have to cover for the
 * slowest player. Stamps are server time whoever sends them, so a new host
 * changes nothing here but the route: `relearn` measures it afresh.
 */
export class ArrivalClock implements SenderClock {
  private readonly server: SenderClock;
  private readonly buckets: { start: number; min: number }[] = [];
  private target: number | null = null;
  private applied: number | null = null;
  private lastRead = 0;

  constructor(server: SenderClock) {
    this.server = server;
  }

  get synced(): boolean {
    return this.target !== null;
  }

  /** The host → server → guest trip now applied (ms); 0 before any frame. */
  get trip(): number {
    return this.applied ?? 0;
  }

  /** Frames now come by a different route (a new host, a new connection):
   *  forget the old route's trips and learn from the next frames. The trip
   *  applied so far stays, and eases onto the new one, so nothing drawn jumps. */
  relearn(): void {
    this.buckets.length = 0;
  }

  /** A frame stamped `t` (server time) arrived at local time `receivedAt`. */
  arrived(t: number, receivedAt: number): void {
    if (!this.server.synced) {
      return;
    }
    const trip = this.server.now(receivedAt) - t;
    if (trip < MIN_TRIP_MS || trip > MAX_TRIP_MS) {
      return;
    }
    const head = this.buckets.at(-1);
    if (head !== undefined && receivedAt - head.start < TRIP_BUCKET_MS) {
      head.min = Math.min(head.min, trip);
    } else {
      this.buckets.push({ min: trip, start: receivedAt });
      while (this.buckets.length > 1) {
        const [oldest] = this.buckets;
        if (!oldest || receivedAt - (oldest.start + TRIP_BUCKET_MS) <= TRIP_WINDOW_MS) {
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

  now(localNow: number = performance.now()): number {
    const server = this.server.now(localNow);
    const { target } = this;
    if (target === null) {
      return server;
    }
    if (this.applied === null || Math.abs(target - this.applied) > TRIP_RESYNC_MS) {
      this.applied = target;
    } else {
      const step = Math.max(0, localNow - this.lastRead) * TRIP_SLEW;
      this.applied += Math.max(-step, Math.min(step, target - this.applied));
    }
    this.lastRead = localNow;
    return server - this.applied;
  }
}
