import { RemoteClock } from "@vibedgames/multiplayer";

/** A better (faster-path) offset estimate is adopted once it beats the held
 *  one by this much (ms)... */
const ADOPT_FASTER_MS = 25;
/** ...and a slower one only past this (a route change or a new clock). */
const ADOPT_SLOWER_MS = 150;

/**
 * The host's sim clock as seen from a guest. Both run on the sim clock
 * (shared/clock.ts) — the clock every world deadline is written in.
 *
 * Two readings: `now()` — the host's time this instant, slewed smoothly, used
 * to age-correct a snapshot — and `toLocal()`, which turns a host deadline
 * (a telegraph's end, an item's expiry) into this client's clock through an
 * offset that is HELD between revisions. The same host deadline must convert
 * to the same local one every time it is decoded: telegraph sounds, beacon
 * instances and the boss tracker key off exact values.
 */
export class HostClock {
  private readonly clock = new RemoteClock();
  /** local - host, held for conversions; null until the first stamp. */
  private offset: number | null = null;

  get synced(): boolean {
    return this.offset !== null;
  }

  /** Record a snapshot stamp and when (local sim clock) it arrived. */
  observe(t: number, receivedAt: number): void {
    this.clock.observe(t, receivedAt);
    const live = receivedAt - this.clock.now(receivedAt);
    if (
      this.offset === null ||
      live < this.offset - ADOPT_FASTER_MS ||
      live > this.offset + ADOPT_SLOWER_MS
    ) {
      this.offset = live;
    }
  }

  /** The host's sim clock now (before any stamp: the local clock). */
  now(localNow: number): number {
    return this.clock.now(localNow);
  }

  /** A host-clock deadline on this client's clock. 0 stays 0 ("none"). */
  toLocal(hostT: number): number {
    return hostT === 0 ? 0 : hostT + (this.offset ?? 0);
  }

  /** A new host keeps a different clock. */
  reset(): void {
    this.clock.reset();
    this.offset = null;
  }
}
