// How a soldier's legs keep up with where its body is going. Nothing tells a
// model how fast it moves — bots and remote players arrive as positions — so
// the gait reads velocity off the positions it is shown, and turns that into
// which locomotion clips play, how far through the stride they are, and which
// way the legs face under an upper body that keeps aiming.
//
// The clips walk forwards or backwards, never sideways, so a sidestep turns
// the hips towards the direction of travel (or away from it, backpedalling)
// and the spine turns back. The stride advances by distance covered, not
// time, so feet do not slide.

/**
 * Locomotion clips: metres a full stride cycle covers, and where in the clip
 * the left foot leads. The backpedal was animated as a slow retreat (0.94 m a
 * cycle); it is given a longer stride than it has, trading a little foot
 * slide for not scurrying at a fighter's pace.
 */
export const STRIDES = {
  back: { lead: 0.7, length: 1.5 },
  "crouch-walk": { lead: 0.258, length: 1.89 },
  jog: { lead: 0.25, length: 3.48 },
  sprint: { lead: 0.93, length: 3.74 },
  walk: { lead: 0.28, length: 1.64 },
} as const;

export type Stride = keyof typeof STRIDES;
export const STRIDE_NAMES: readonly Stride[] = ["walk", "jog", "sprint", "back", "crouch-walk"];

/** Metres per second each clip was animated at (stride length over its duration). */
const PACE = { jog: 5.19, sprint: 7.96, walk: 1.53 };

/** Hips never turn further than this from the chest; past it the feet slide a little. */
const MAX_TWIST = 1.2;
/** Standing, the feet stay planted until the body has turned this far, then step round. */
const STEP_AT = 0.85;
const STEP_RATE = 4.2;
/** The stride a turn on the spot is shown with, as a walking speed. */
const STEP_PACE = 1.1;
/** Slower than this is standing. */
const STILL = 0.25;
/** A jump in position this long is a respawn, not a sprint. */
const TELEPORT = 3;

export type GaitWeights = Record<Stride, number>;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

const smoothstep = (lo: number, hi: number, v: number): number => {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Which clips show a body moving at `pace` m/s, `crouch` 0–1, stepping
 * backwards or not. What they leave short of 1 is standing still: the pose
 * the body was rigged in, a ready stance. There is no crouched idle: a
 * crouched soldier standing still holds its crouched stride.
 */
export const gaitWeights = (pace: number, crouch: number, back: boolean): GaitWeights => {
  const moving = smoothstep(0.1, 0.8, pace);
  const jogging = clamp((pace - PACE.walk) / (PACE.jog - PACE.walk), 0, 1);
  const sprinting = clamp((pace - PACE.jog) / (PACE.sprint - PACE.jog), 0, 1);
  const up = moving * (1 - crouch);
  return {
    back: back ? up : 0,
    "crouch-walk": crouch,
    jog: back ? 0 : up * jogging * (1 - sprinting),
    sprint: back ? 0 : up * sprinting,
    walk: back ? 0 : up * (1 - jogging),
  };
};

/** Metres one stride cycle covers under `weights`. */
export const strideLength = (weights: GaitWeights): number => {
  let moving = 0;
  let length = 0;
  for (const name of STRIDE_NAMES) {
    moving += weights[name];
    length += weights[name] * STRIDES[name].length;
  }
  return moving < 1e-4 ? STRIDES.walk.length : length / moving;
};

export class Gait {
  /** Planar speed, smoothed, m/s. */
  speed = 0;
  /** 0–1 through the stride cycle. */
  phase = 0;
  /** Radians the hips are turned from the chest, positive to the left. */
  twist = 0;
  /** Stepping backwards. */
  back = false;
  weights: GaitWeights = gaitWeights(0, 0, false);
  private x = Number.NaN;
  private z = 0;
  private yaw = 0;
  private vx = 0;
  private vz = 0;
  private stepping = false;

  /** The body is at (x, z) facing `yaw`, `crouch` 0–1, `dt` seconds on. */
  update(x: number, z: number, yaw: number, crouch: number, dt: number): void {
    const jumped = Math.hypot(x - this.x, z - this.z) > TELEPORT;
    if (Number.isNaN(this.x) || jumped) {
      this.x = x;
      this.z = z;
      this.yaw = yaw;
      this.vx = 0;
      this.vz = 0;
      this.twist = 0;
      this.stepping = false;
    }
    if (dt <= 0) {
      return;
    }
    const k = 1 - Math.exp(-12 * dt);
    this.vx += ((x - this.x) / dt - this.vx) * k;
    this.vz += ((z - this.z) / dt - this.vz) * k;
    const turned = wrap(yaw - this.yaw);
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.speed = Math.hypot(this.vx, this.vz);

    let pace = this.speed;
    if (this.speed > STILL) {
      this.stepping = false;
      // Facing is (-sin yaw, -cos yaw); its right is (cos yaw, -sin yaw).
      const forward = -Math.sin(yaw) * this.vx - Math.cos(yaw) * this.vz;
      const right = Math.cos(yaw) * this.vx - Math.sin(yaw) * this.vz;
      const heading = Math.atan2(right, forward);
      // Hysteresis, so a pure sidestep does not flap between the two.
      this.back = this.back ? Math.abs(heading) > 1.4 : Math.abs(heading) > 1.9;
      const want = clamp(wrap(-heading + (this.back ? Math.PI : 0)), -MAX_TWIST, MAX_TWIST);
      this.twist += (want - this.twist) * (1 - Math.exp(-9 * dt));
    } else {
      // The chest turned; the feet did not.
      this.twist = clamp(this.twist - turned, -MAX_TWIST, MAX_TWIST);
      this.back = false;
      if (Math.abs(this.twist) > STEP_AT) {
        this.stepping = true;
      }
      if (this.stepping) {
        const step = Math.min(Math.abs(this.twist), STEP_RATE * dt);
        this.twist -= Math.sign(this.twist) * step;
        this.stepping = Math.abs(this.twist) > 0.03;
        pace = Math.max(pace, STEP_PACE);
      }
    }
    this.weights = gaitWeights(pace, crouch, this.back);
    this.phase = (this.phase + (pace * dt) / strideLength(this.weights)) % 1;
  }
}
