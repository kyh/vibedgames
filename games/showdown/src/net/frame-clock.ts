import { RemoteClock } from "@vibedgames/multiplayer";

import { INTERP_DELAY_MS } from "./protocol";

/** Server time as the host's frames carry it, read off their arrivals. */
export class FrameClock extends RemoteClock {
  private host: string | null = null;

  /** A frame `host` stamped `sentAt` arrived at local `receivedAt`. */
  arrived(sentAt: number, receivedAt: number, host: string | null) {
    if (host !== this.host) {
      this.host = host;
      this.relearn();
    }

    this.observe(sentAt, receivedAt);
  }

  /**
   * The moment remote bodies are drawn at, local time `localNow`: INTERP_DELAY_MS
   * behind this clock, or as far as the stream needs — what every puppet's
   * `Interpolator` renders at. Rows, fx and loot changes play at this moment
   * too, so each lands with the body it belongs to.
   */
  renderTime(localNow: number) {
    return this.now(localNow) - Math.max(INTERP_DELAY_MS, this.hold(localNow, INTERP_DELAY_MS));
  }
}
