// How a soldier's legs keep up with where its body is going. Nothing tells a
// model how fast it moves — bots and remote players arrive as positions — so
// the gait reads velocity off the positions it is shown, and turns that into
// which locomotion clips play, how far through the stride they are, and which
// way the legs face under an upper body that keeps aiming.
//
// Two regimes. Slow — a fighter's pace while it fires — is a shuffle: real
// sidestep and backpedal clips, hips square. The sidestep clips cover half a
// metre a second, so faster than that the body walks, jogs or sprints with
// its hips turned towards the direction of travel (or away from it, on the
// backpedal) and the spine turned back. The stride advances by distance
// covered, not time, so feet do not slide.

/**
 * Locomotion clips: metres a full stride cycle covers, and where in the clip
 * the left foot is mid-stance. A mirrored clip's left foot is its source's
 * right, half a cycle on.
 */
export const STRIDES = {
  back: { lead: 0.53, length: 1.15 },
  "crouch-back": { lead: 0.58, length: 0.92 },
  "crouch-left": { lead: 0.47, length: 0.9 },
  "crouch-right": { lead: 0.97, length: 0.9 },
  "crouch-walk": { lead: 0.45, length: 1.68 },
  jog: { lead: 0.4, length: 2.87 },
  sprint: { lead: 0.49, length: 2.63 },
  "strafe-left": { lead: 0.48, length: 0.8 },
  "strafe-right": { lead: 0.98, length: 0.8 },
  walk: { lead: 0.51, length: 1.48 },
} as const;

export type Stride = keyof typeof STRIDES;
export const STRIDE_NAMES: readonly Stride[] = [
  "walk",
  "jog",
  "sprint",
  "back",
  "strafe-left",
  "strafe-right",
  "crouch-walk",
  "crouch-back",
  "crouch-left",
  "crouch-right",
];

/** Metres per second each forward clip was animated at. */
const PACE = { jog: 4.3, sprint: 5.27, walk: 1.39 };
/** Up to the first it shuffles; from the second it strides with its hips turned. */
const SHUFFLE: readonly [number, number] = [0.9, 1.6];

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

/** How much of a body moving at `pace` m/s strides rather than shuffles. */
export const striding = (pace: number): number => smoothstep(SHUFFLE[0], SHUFFLE[1], pace);

/**
 * Which clips show a body moving at `pace` m/s towards `heading` (radians
 * from its facing, positive to its right), `crouch` 0–1, `back` when its
 * stride is a backpedal. What they leave short of 1 is standing still: the
 * rig's rest pose. There is no crouched idle: a crouched soldier standing
 * still holds its crouched stride.
 */
export const gaitWeights = (
  pace: number,
  heading: number,
  crouch: number,
  back: boolean,
): GaitWeights => {
  const moving = smoothstep(0.1, 0.8, pace);
  const stride = striding(pace);
  const shuffle = 1 - stride;
  const ahead = Math.max(0, Math.cos(heading)) ** 2;
  const behind = Math.max(0, -Math.cos(heading)) ** 2;
  const right = Math.max(0, Math.sin(heading)) ** 2;
  const left = Math.max(0, -Math.sin(heading)) ** 2;
  const jogging = clamp((pace - PACE.walk) / (PACE.jog - PACE.walk), 0, 1);
  const sprinting = clamp((pace - PACE.jog) / (PACE.sprint - PACE.jog), 0, 1);
  const up = moving * (1 - crouch);
  // Striding goes wherever the hips point: forwards, or backwards on the backpedal.
  const forth = up * (shuffle * ahead + (back ? 0 : stride));
  // Standing still, a crouch holds the forward clip.
  const low = crouch * (1 - moving);
  const down = crouch * moving;
  return {
    back: up * (shuffle * behind + (back ? stride : 0)),
    "crouch-back": down * (shuffle * behind + (back ? stride : 0)),
    "crouch-left": down * shuffle * left,
    "crouch-right": down * shuffle * right,
    "crouch-walk": low + down * (shuffle * ahead + (back ? 0 : stride)),
    jog: forth * jogging * (1 - sprinting),
    sprint: forth * sprinting,
    "strafe-left": up * shuffle * left,
    "strafe-right": up * shuffle * right,
    walk: forth * (1 - jogging),
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
  /** Planar velocity, smoothed, m/s, and its size. */
  vx = 0;
  vz = 0;
  speed = 0;
  /** 0–1 through the stride cycle. */
  phase = 0;
  /** Radians the hips are turned from the chest, positive to the left. */
  twist = 0;
  /** Its stride is a backpedal. */
  back = false;
  weights: GaitWeights = gaitWeights(0, 0, 0, false);
  private x = Number.NaN;
  private z = 0;
  private yaw = 0;
  private heading = 0;
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
      this.heading = Math.atan2(right, forward);
      // Hysteresis, so a pure sidestep does not flap between the two.
      this.back = this.back ? Math.abs(this.heading) > 1.4 : Math.abs(this.heading) > 1.9;
      const toward = clamp(wrap(-this.heading + (this.back ? Math.PI : 0)), -MAX_TWIST, MAX_TWIST);
      const want = toward * striding(this.speed);
      this.twist += (want - this.twist) * (1 - Math.exp(-9 * dt));
    } else {
      // The chest turned; the feet did not.
      this.twist = clamp(this.twist - turned, -MAX_TWIST, MAX_TWIST);
      this.back = false;
      this.heading = 0;
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
    this.weights = gaitWeights(pace, this.heading, crouch, this.back);
    this.phase = (this.phase + (pace * dt) / strideLength(this.weights)) % 1;
  }
}
