const TRAUMA_DECAY = 1.6;
const MAX_OFFSET = 0.16;
const MAX_ROT = 0.04;

const shakeNoise = (t: number, phase: number) =>
  (Math.sin(t * 31 + phase) + 0.5 * Math.sin(t * 47 + phase * 1.7)) / 1.5;

/** Frame sample: positional offset (world units) + roll (radians). */
export interface ShakeSample {
  ox: number;
  oy: number;
  rot: number;
}

export class TraumaCamera {
  private trauma = 0;
  private readonly phaseX = Math.random() * 100;
  private readonly phaseY = Math.random() * 100;
  private readonly phaseR = Math.random() * 100;

  /** Events add trauma; clamped so total shake time stays bounded. */
  add(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  reset() {
    this.trauma = 0;
  }

  /** Decay + sample the current frame's offset/roll. tSec = elapsed seconds. */
  update(dt: number, tSec: number) {
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    const shake = this.trauma * this.trauma;

    if (shake <= 0.0001) {
      return { ox: 0, oy: 0, rot: 0 };
    }

    return {
      ox: MAX_OFFSET * shake * shakeNoise(tSec, this.phaseX),
      oy: MAX_OFFSET * shake * shakeNoise(tSec, this.phaseY),
      rot: MAX_ROT * shake * shakeNoise(tSec, this.phaseR),
    };
  }
}
