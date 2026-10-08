// How each rival's dragon moves on this screen. Free of Phaser so
// tools/net.test.mts can drive it headless.

import { Interpolator, lerp } from "@vibedgames/multiplayer";
import type { SenderClock } from "@vibedgames/multiplayer";

/** What a rival's dragon streams per tick, as rendered between ticks. */
export interface DragonPose {
  live: boolean;
  vy: number;
  y: number;
}

/**
 * A step between consecutive samples bigger than any flight covers in one
 * NET_TICK_HZ interval (a full dive is ~50 px) is a teleport.
 */
export const RIVAL_TELEPORT_PX = 150;

/**
 * How far behind the relayed clock a rival is drawn (ms): one send interval
 * at NET_TICK_HZ plus arrival jitter, so the samples on both sides of the
 * moment drawn have landed.
 */
export const RIVAL_DELAY_MS = 100;

const blendPose = (a: DragonPose, b: DragonPose, k: number): DragonPose => ({
  // A crash shows where it happened: the dragon flies on into the trunk and
  // greys out mid-blend, instead of skipping ahead to the wreck.
  live: k < 0.5 ? a.live : b.live,
  vy: lerp(a.vy, b.vy, k),
  y: lerp(a.y, b.y, k),
});

/**
 * The room's clock held back by the relay: a rival's sample lands here a hop
 * up to the server and a hop down after its stamp, about one round trip of
 * ours when routes are alike. Drawn on the bare server clock, the moment shown
 * would be newer than every sample that has arrived.
 */
const relayed = (room: SenderClock, rtt: () => number): SenderClock => ({
  now: (localNow) => {
    const trip = rtt();
    return room.now(localNow) - (Number.isFinite(trip) ? trip : 0);
  },
  get synced() {
    return room.synced;
  },
});

/**
 * One rival's dragon, drawn from the samples it streams, each stamped with
 * the room's server time when it was sent. Every rival shares that clock, so
 * nothing is estimated per sender and nothing restarts when the host does.
 * Drawn a relay plus RIVAL_DELAY_MS behind it, blending the two samples
 * around that moment: drawing the newest sample instead jumped the dragon
 * 20–50 px at every packet, right in your forward view.
 */
export class RivalMotion {
  /** Stamp of the newest sample pushed: state is polled every frame, but only a new stamp is news. */
  stamp = Number.NaN;
  private readonly interp: Interpolator<DragonPose>;
  private life = Number.NaN;

  /** `clock` is the room's server clock; `rtt` reads our current round trip to the server. */
  constructor(clock: SenderClock, rtt: () => number) {
    this.interp = new Interpolator({
      clock: relayed(clock, rtt),
      delayMs: RIVAL_DELAY_MS,
      lerp: blendPose,
    });
  }

  /**
   * Add the sample stamped `t` (server time). A new `life` (a respawn or
   * restart) or a jump no flight covers is a teleport: the history goes, so
   * the dragon appears there instead of gliding across the screen.
   */
  push(t: number, life: number, pose: DragonPose): void {
    const last = this.interp.latest;
    if (
      life !== this.life ||
      (last !== undefined && Math.abs(pose.y - last.y) > RIVAL_TELEPORT_PX)
    ) {
      this.interp.clear();
    }
    this.life = life;
    this.stamp = t;
    this.interp.push(t, pose);
  }

  /** The pose to draw at local time `now`; undefined before the first sample. */
  sample(now?: number): DragonPose | undefined {
    return this.interp.sample(now);
  }
}
