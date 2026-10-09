// The clock a guest renders the host's frames on. Frames are stamped with the
// room's server time, so the timeline is one clock across every host: a
// migration throws nothing queued away. It is read off the frames' arrivals
// (`RemoteClock`) rather than off this guest's own server clock, which a stall
// while booting can leave far out until its next clean probe; the fastest recent
// arrival also carries the relay's latency, so INTERP_DELAY_MS covers only
// jitter. A new host reaches the server by its own route: from that host's
// first frame the clock relearns the route and eases onto it, rather than
// jumping what is drawn. Each arrival is tagged with the host whose route it
// came by, as the old host's last frames can land after the host-change notice
// is handled.
import { RemoteClock } from "@vibedgames/multiplayer";

/** Server time as the host's frames carry it, read off their arrivals. */
export class FrameClock extends RemoteClock {
  private host: string | null = null;

  /** A frame `host` stamped `sentAt` arrived at local `receivedAt`. */
  arrived(sentAt: number, receivedAt: number, host: string | null): void {
    if (host !== this.host) {
      this.host = host;
      this.relearn();
    }
    this.observe(sentAt, receivedAt);
  }
}
