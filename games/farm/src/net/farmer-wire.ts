import { FixedRate, Interpolator, lerp } from "@vibedgames/multiplayer";

import { NET_TICK_HZ } from "../config";
import { CHAR_FRAMES } from "../data/character";
import type { CharAction } from "../data/character";
import { isJsonNumber, isJsonObject, isJsonString } from "../json";
import type { JsonObject, JsonValue } from "../json";

// A farmer's player state on the wire. Primitive keys only — the SDK diffs
// primitives against the last send and re-sends any object or array whole:
//   t  server time (ms)         x, y  feet, to 0.1 px      f  facing left
//   m  walking                  h     away (down the mine)
//   a  clip   r  clip revision  p     clip playing
//   k  clip frame, e  ms into it — sent only when `r` or `p` changes

/** One remote farmer at one moment, as its sender reported it. */
export interface FarmerSample {
  x: number;
  y: number;
  flip: boolean;
  moving: boolean;
  /** Off the farm (down the mine): not drawn. */
  away: boolean;
  /** The sender's clip, or null for a sender that reports motion only. */
  clip: CharAction | null;
  /** Bumped by the sender each time a clip (re)starts. */
  revision: number;
  playing: boolean;
  /** Where the clip stood when its revision or playing flag last changed. */
  frame: number;
  elapsed: number;
}

/** What the wire reads off the local farmer's sprite (a Phaser Sprite fits). */
export interface FarmerBody {
  x: number;
  y: number;
  flipX: boolean;
  anims: {
    currentAnim: { key: string } | null;
    currentFrame: { index: number } | null;
    isPlaying: boolean;
    accumulator: number;
  };
}

const isAction = (value: JsonValue | undefined): value is CharAction =>
  isJsonString(value) && Object.hasOwn(CHAR_FRAMES, value);

/**
 * Interpolator blend for farmers. Position blends; facing, motion and clip
 * come whole from one of the two updates, so the pose always belongs to the
 * body. While the body moves between them that is the walking one — it walks
 * out of a start and into a stop instead of sliding in its idle pose — and
 * otherwise the nearer one.
 */
export const blendFarmer = (a: FarmerSample, b: FarmerSample, k: number): FarmerSample => {
  let pose = k < 0.5 ? a : b;
  if (a.x !== b.x || a.y !== b.y) {
    if (b.moving) {
      pose = b;
    } else if (a.moving) {
      pose = a;
    }
  }
  return { ...pose, x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
};

/**
 * One remote farmer's playback. Its interpolator keeps that sender's own
 * clock (a RemoteClock, the default), which learns from the arrivals how long
 * this sender's updates take to get here — its hop up to the server and this
 * client's hop down — so a farmer on a slow route plays as smoothly as one on
 * a fast route, and the default ~100 ms delay only has to cover the send
 * interval and the jitter.
 */
export const farmerTrack = (): Interpolator<FarmerSample> =>
  new Interpolator({ lerp: blendFarmer });

const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * The local farmer on the wire. Primitives only: the SDK diffs primitive keys
 * against the last send and re-sends any object whole, so a farmer standing
 * still costs just the timestamp. Sent on a steady clock, not per frame.
 */
export class FarmerSender {
  private readonly rate = new FixedRate(NET_TICK_HZ);
  private lastTick: number | null = null;
  private stamp = 0;
  private seekRevision = -1;
  private seekPlaying = false;
  private gone = false;

  /**
   * This frame's update, or null between ticks. `now` is the room's server
   * time (`serverNow()`): it stamps the update, so every peer reads the stamp
   * as the same instant, and it drives the send clock — real time, like the
   * stamps peers play back against. Phaser's frame delta is smoothed and
   * clamps to 16.7 ms on an unfocused or stalling page, which would stretch
   * the gaps between updates past the peers' playback delay.
   */
  tick(body: FarmerBody, moving: boolean, revision: number, now: number): JsonObject | null {
    const elapsed = this.lastTick === null ? 0 : now - this.lastTick;
    this.lastTick = now;
    return this.rate.due(elapsed) && !this.gone ? this.snapshot(body, moving, revision, now) : null;
  }

  /**
   * Leaving the farm: one last update, so peers hide this farmer instead of
   * leaving it frozen at the door. Silent from then until `arrive()` — the
   * scene that sent it can still update once before it stops, and a regular
   * update would show the farmer again.
   */
  away(now: number): JsonObject {
    this.gone = true;
    return { h: true, t: this.nextStamp(now) };
  }

  /** Back on the farm: updates resume, and the first shows the farmer again. */
  arrive(): void {
    this.gone = false;
  }

  private snapshot(body: FarmerBody, moving: boolean, revision: number, now: number): JsonObject {
    const { anims } = body;
    const update: JsonObject = {
      f: body.flipX,
      h: false,
      m: moving,
      t: this.nextStamp(now),
      x: round1(body.x),
      y: round1(body.y),
    };
    const clip = anims.currentAnim?.key.replace(/^p-/u, "");
    if (!isAction(clip)) {
      return update;
    }
    update["a"] = clip;
    update["r"] = revision;
    update["p"] = anims.isPlaying;
    // Where the clip stands matters only when peers must seek: a new clip, or
    // one that paused or resumed. In between, each peer runs it locally.
    if (revision !== this.seekRevision || anims.isPlaying !== this.seekPlaying) {
      this.seekRevision = revision;
      this.seekPlaying = anims.isPlaying;
      update["k"] = (anims.currentFrame?.index ?? 1) - 1;
      update["e"] = Math.round(anims.accumulator);
    }
    return update;
  }

  /** Strictly increasing, so an update sent between ticks is never a duplicate. */
  private nextStamp(now: number): number {
    this.stamp = Math.max(this.stamp + 1, Math.round(now));
    return this.stamp;
  }
}

/** A sender's player state as one sample plus its server-time stamp; null
 *  without a position or a stamp. */
export const readFarmer = (
  state: JsonValue | undefined,
): { t: number; sample: FarmerSample } | null => {
  if (!isJsonObject(state)) {
    return null;
  }
  const { a: clip, e: elapsed, k: frame, r: revision, t, x, y } = state;
  if (!isJsonNumber(t) || !isJsonNumber(x) || !isJsonNumber(y)) {
    return null;
  }
  const sample: FarmerSample = {
    away: state["h"] === true,
    clip: null,
    elapsed: 0,
    flip: state["f"] === true,
    frame: 0,
    moving: state["m"] === true,
    playing: state["p"] !== false,
    revision: 0,
    x,
    y,
  };
  if (
    isAction(clip) &&
    isJsonNumber(revision) &&
    Number.isSafeInteger(revision) &&
    revision >= 0 &&
    isJsonNumber(frame) &&
    Number.isInteger(frame) &&
    frame >= 0 &&
    frame < CHAR_FRAMES[clip] &&
    isJsonNumber(elapsed) &&
    elapsed >= 0 &&
    elapsed <= 1000
  ) {
    sample.clip = clip;
    sample.revision = revision;
    sample.frame = frame;
    sample.elapsed = elapsed;
  }
  return { sample, t };
};
