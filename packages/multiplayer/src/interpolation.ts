/**
 * Snapshot interpolation for remote entities.
 *
 * Updates from another client arrive 10–30 times a second, unevenly (TCP
 * bunching, frame-quantized sends). Chasing the newest value — an exponential
 * lerp, or snapping — shows every gap and burst as a surge or a stall. The
 * idiomatic fix: the sender stamps each update with its own clock, the
 * receiver buffers a few, and renders each entity a delay in the past,
 * blending the two updates that bracket that moment. Motion is then exactly
 * as smooth as the sender's, at the cost of ~one send interval of delay. The
 * delay is `delayMs`, or more when the stream needs it: a `RemoteClock`
 * measures how late this sender's updates land and the buffer grows to match,
 * on a jittery route or a device too busy to read its messages on time.
 *
 * ```ts
 * // sender, on a FixedRate tick (keep ticking while idle: an unchanged
 * // position costs only the `t` key on the wire):
 * client.updateMyState({ t: Math.round(performance.now()), x, y });
 *
 * // receiver, one Interpolator per remote player:
 * const interp = new Interpolator<Pose>({
 *   lerp: (a, b, k) => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) }),
 * });
 * interp.push(state.t, { x: state.x, y: state.y }); // duplicate stamps are ignored
 * const pose = interp.sample(); // each frame
 * ```
 */

import { countFrame, countUpdate } from "./net-stats.js";
import { RemoteClock } from "./remote-clock.js";
import type { SenderClock } from "./remote-clock.js";

const now = (): number => performance.now();

/** Linear blend; `t` outside [0, 1] extrapolates. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Blend two angles in radians along the shorter arc (yaw, heading, rotation). */
export const lerpAngle = (a: number, b: number, t: number): number => {
  const turn = Math.PI * 2;
  let delta = (b - a) % turn;
  if (delta > Math.PI) {
    delta -= turn;
  } else if (delta < -Math.PI) {
    delta += turn;
  }
  return a + delta * t;
};

export interface InterpolatorOptions<T> {
  /**
   * Blend two updates: `alpha` 0 is `a`, 1 is `b`, above 1 extrapolates.
   * Build it from `lerp` and `lerpAngle`; step discrete fields (an animation
   * name, a flag) to whichever side `alpha` is nearer.
   */
  lerp: (a: T, b: T, alpha: number) => T;
  /**
   * The least time behind the sender's clock to render (ms). It should cover
   * one send interval plus arrival jitter on a good connection: 100 suits
   * 20–30 Hz senders, ~150 suits 10–15 Hz. Default 100. With a `RemoteClock`
   * (the default) the delay also grows to what the stream measurably needs
   * (`RemoteClock.hold`), so one setting holds on a slow route or a busy
   * device without starving the buffer.
   */
  delayMs?: number;
  /**
   * How far past the newest update to keep moving, along the last two
   * updates' velocity, when the next one is late (ms). Past this the entity
   * holds still. 0 never extrapolates. Default 100.
   */
  maxExtrapolateMs?: number;
  /** Updates kept. Must span `delayMs` at the sender's rate. Default 32. */
  capacity?: number;
  /**
   * The clock stamps are read against. Default: a private `RemoteClock`, which
   * learns from arrivals how long this sender's updates take to reach you, so
   * `delayMs` only has to cover jitter. Share one across every entity from the
   * same sender. A clock with no arrival model, like the client's
   * `serverClock`, needs `delayMs` to cover the whole relay as well.
   */
  clock?: SenderClock;
}

interface Sample<T> {
  t: number;
  value: T;
}

/** An earlier stamp by more than this is a restarted sender clock, not reordering. */
const CLOCK_RESTART_MS = 1000;
/** Assumed send interval until the stream shows its own. */
const DEFAULT_GAP_MS = 50;
/** Gaps tracked to learn the sender's interval. */
const GAP_HISTORY = 8;
/**
 * A gap shorter than this is a send cadence, however slow (a grid mover
 * stepping every 180 ms), never an idle silence to bridge.
 */
const MIN_SILENCE_MS = 300;

/**
 * A short timestamped history of one remote entity, sampled at a fixed delay
 * behind the sender's clock. Push each update (duplicate and stale stamps are
 * dropped, so pushing every frame is safe); `sample()` each frame.
 *
 * Senders that go quiet while idle are handled: after a long gap the entity
 * holds its old value until one send interval before the new update, rather
 * than gliding across the whole gap.
 */
export class Interpolator<T> {
  readonly clock: SenderClock;
  readonly delayMs: number;
  private readonly maxExtrapolateMs: number;
  private readonly capacity: number;
  private readonly blend: (a: T, b: T, alpha: number) => T;
  private readonly ownsClock: boolean;
  private readonly samples: Sample<T>[] = [];
  private readonly gaps: number[] = [];

  constructor(options: InterpolatorOptions<T>) {
    this.ownsClock = options.clock === undefined;
    this.clock = options.clock ?? new RemoteClock();
    this.delayMs = options.delayMs ?? 100;
    this.maxExtrapolateMs = options.maxExtrapolateMs ?? 100;
    this.capacity = Math.max(2, options.capacity ?? 32);
    this.blend = options.lerp;
  }

  /** The newest value pushed, undelayed — for reads that must not lag (HUD numbers). */
  get latest(): T | undefined {
    return this.samples.at(-1)?.value;
  }

  /**
   * Add an update stamped `sentAt` on the sender's clock. Returns false for a
   * duplicate or stale stamp, which is dropped.
   *
   * `sentAt` is when the update was sent — never a future or past event time
   * (a step's arrival, a shot's impact): the clock estimate reads it as send
   * time, and a shifted stamp shifts every entity from that sender. A grid
   * mover stamps each step as it starts and needs `delayMs` of at least one
   * stride plus jitter; with `maxExtrapolateMs: 0` it then walks each step
   * over the interval between step starts and never overshoots its tile.
   */
  push(sentAt: number, value: T, receivedAt: number = now()): boolean {
    const newest = this.samples.at(-1);
    if (newest !== undefined) {
      if (sentAt <= newest.t && newest.t - sentAt < CLOCK_RESTART_MS) {
        return false;
      }
      if (sentAt < newest.t) {
        // The sender restarted its clock (a reload under the same identity).
        this.clear();
        if (this.ownsClock) {
          this.clock.reset?.();
        }
      } else {
        this.bridgeGap(newest, sentAt);
      }
    }
    this.clock.observe?.(sentAt, receivedAt);
    this.samples.push({ t: sentAt, value });
    while (this.samples.length > this.capacity) {
      this.samples.shift();
    }
    countUpdate();
    return true;
  }

  /**
   * The entity's value at `localNow` minus the delay, or undefined before the
   * first push. Holds the oldest value when render time predates the buffer
   * and the newest once extrapolation runs out.
   */
  sample(localNow: number = now()): T | undefined {
    const { samples } = this;
    const last = samples.at(-1);
    if (last === undefined) {
      return undefined;
    }
    const renderAt = this.renderTime(localNow);
    countFrame(renderAt - last.t, this.maxExtrapolateMs);
    if (renderAt >= last.t) {
      const prev = samples.at(-2);
      const ahead = Math.min(renderAt - last.t, this.maxExtrapolateMs);
      if (prev === undefined || ahead <= 0) {
        return last.value;
      }
      return this.blend(prev.value, last.value, 1 + ahead / (last.t - prev.t));
    }
    for (let i = samples.length - 2; i >= 0; i -= 1) {
      const a = samples[i];
      const b = samples[i + 1];
      if (a !== undefined && b !== undefined && a.t <= renderAt) {
        return this.blend(a.value, b.value, (renderAt - a.t) / (b.t - a.t));
      }
    }
    return samples[0]?.value;
  }

  /**
   * The moment on the sender's clock this entity is drawn at, local time
   * `localNow`: `delayMs` behind it, or as far as the stream needs. Draw
   * anything else from this sender on the same timeline (its shots, its
   * effects) at this time too, so they line up with what it is attached to.
   */
  renderTime(localNow: number = now()): number {
    return this.clock.now(localNow) - Math.max(this.delayMs, this.clock.hold?.(localNow) ?? 0);
  }

  /** Drop the history so the next push shows at once — a teleport, respawn or new round. */
  clear(): void {
    this.samples.length = 0;
    this.gaps.length = 0;
  }

  /**
   * Learn the sender's interval, and bridge a long silence: an entity whose
   * sender went quiet while it stood still, then moved, held its old value
   * until about one interval before the new update — it must not glide
   * across the whole gap.
   */
  private bridgeGap(newest: Sample<T>, sentAt: number): void {
    const gap = sentAt - newest.t;
    let typical = Number.POSITIVE_INFINITY;
    for (const seen of this.gaps) {
      typical = Math.min(typical, seen);
    }
    if (!Number.isFinite(typical)) {
      typical = DEFAULT_GAP_MS;
    }
    // Learned whether bridged or not: the minimum ignores the odd silence,
    // and a slow steady sender must teach its cadence rather than read as
    // idle on every update.
    this.gaps.push(gap);
    if (this.gaps.length > GAP_HISTORY) {
      this.gaps.shift();
    }
    if (gap > Math.max(typical * 3, MIN_SILENCE_MS) && sentAt - typical > newest.t) {
      this.samples.push({ t: sentAt - typical, value: newest.value });
    }
  }
}
