/**
 * The party server's clock, as measured from this client — one timebase every
 * client in a room shares, so a stamp one player writes means the same moment
 * to every other player, and survives host migration unchanged.
 */

const now = (): number => performance.now();

/** Probe samples kept; the fastest round trip among them defines the offset. */
const SAMPLES = 8;
/** A new estimate this far from the applied one is adopted at once (first sync, a long stall). */
const RESYNC_MS = 250;
/** Smaller revisions bend playback speed by at most this fraction instead of jumping. */
const SLEW = 0.1;

interface Sample {
  rtt: number;
  offset: number;
}

/**
 * Server time from NTP-style probes: the client sends its clock `c`, the
 * server answers with its own `s`, and the reply lands at `r`. The server
 * read its clock somewhere inside that round trip, so `s - (c + r) / 2` is
 * the offset, accurate to half the asymmetry of the trip — and the fastest
 * recent trip is the least asymmetric one, so that sample wins.
 *
 * Satisfies the clock an `Interpolator` takes, but a stamp reaches a receiver
 * a whole relay after it was taken (sender → server → receiver), so rendering
 * on it needs a delay that covers that too. A `RemoteClock` per sender learns
 * the relay from arrivals instead.
 */
export class ServerClock {
  private readonly samples: Sample[] = [];
  private target: number | null = null;
  private applied: number | null = null;
  private lastRead = 0;
  private bestRtt = Number.NaN;

  /** True once a probe has come back. */
  get synced(): boolean {
    return this.target !== null;
  }

  /**
   * True once a full window of probes has come back. Until then one slow
   * probe (a page stalled while booting) can define the offset, so keep
   * probing fast.
   */
  get settled(): boolean {
    return this.samples.length >= SAMPLES;
  }

  /** The fastest recent round trip to the server (ms); NaN before the first probe returns. */
  get rtt(): number {
    return this.bestRtt;
  }

  /** Fold in one probe: sent at local `c`, answered with server time `s`, received at local `r`. */
  sample(c: number, s: number, r: number = now()): void {
    const rtt = Math.max(0, r - c);
    this.samples.push({ offset: s - (c + r) / 2, rtt });
    while (this.samples.length > SAMPLES) {
      this.samples.shift();
    }
    let [best] = this.samples;
    for (const candidate of this.samples) {
      if (best === undefined || candidate.rtt < best.rtt) {
        best = candidate;
      }
    }
    if (best !== undefined) {
      this.target = best.offset;
      this.bestRtt = best.rtt;
    }
  }

  /**
   * Offline: no server to probe, and the room is this client alone. A clock
   * that measured the server keeps that offset, so stamps taken online stay
   * comparable; one that never did takes the local clock as the room's.
   */
  adoptLocal(): void {
    if (this.target === null) {
      this.target = 0;
      this.bestRtt = 0;
    }
  }

  /** Server time (ms since the epoch) at local time `localNow`; the local clock
   *  (`performance.now()`) before any probe returns, or offline without one. */
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
    return localNow + this.applied;
  }
}
