// How each rival's dragon moves on this screen. Free of Phaser so
// tools/net.test.mts can drive it headless.

import { Interpolator, lerp } from "@vibedgames/multiplayer";

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

const blendPose = (a: DragonPose, b: DragonPose, k: number): DragonPose => ({
  // A crash shows where it happened: the dragon flies on into the trunk and
  // greys out mid-blend, instead of skipping ahead to the wreck.
  live: k < 0.5 ? a.live : b.live,
  vy: lerp(a.vy, b.vy, k),
  y: lerp(a.y, b.y, k),
});

/**
 * One rival's dragon, drawn 100 ms or more behind the moment its samples
 * land. The samples are stamped with the room's server time; the
 * Interpolator's own RemoteClock learns from arrivals how long this rival's
 * take to get here (its hop up to the server and ours down), so the delay
 * only covers the send interval and jitter, on a slow route as on a fast
 * one. The clock measures those too: on a jittery route, or a page too busy
 * to read its messages on time, the delay grows as far as the stream needs
 * instead of running dry. Drawing the newest sample instead jumped the
 * dragon 20–50 px at every packet, right in your forward view.
 */
export class RivalMotion {
  /** Stamp of the newest sample pushed: state is polled every frame, but only a new stamp is news. */
  stamp = Number.NaN;
  private readonly interp = new Interpolator<DragonPose>({ lerp: blendPose });
  private life = Number.NaN;

  /**
   * Add the sample stamped `t` (server time), seen at local time
   * `receivedAt`. A new `life` (a respawn or restart) or a jump no flight
   * covers is a teleport: the history goes, so the dragon appears there
   * instead of gliding across the screen.
   */
  push(t: number, life: number, pose: DragonPose, receivedAt?: number): void {
    const last = this.interp.latest;
    if (
      life !== this.life ||
      (last !== undefined && Math.abs(pose.y - last.y) > RIVAL_TELEPORT_PX)
    ) {
      this.interp.clear();
    }
    this.life = life;
    this.stamp = t;
    this.interp.push(t, pose, receivedAt);
  }

  /** The pose to draw at local time `now`; undefined before the first sample. */
  sample(now?: number): DragonPose | undefined {
    return this.interp.sample(now);
  }
}
