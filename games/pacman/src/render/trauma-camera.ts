// Trauma-based camera shake (Eiserloh, GDC 2016), 3D flavor: events ADD
// trauma, shake magnitude = trauma², sampled from layered sin noise per axis.
// Offsets are in world units (applied along the camera's right/up axes) plus
// a small roll — tuned gentle: this is a cozy game, the shake is a wobble,
// not violence.
//
// Sibling copies (starfall/tetris) share this structure; only the tuning
// constants and the unit of `rot` (radians here, degrees for 2D Phaser games)
// legitimately differ. Keep the shape identical so drift stays visible.

/** Linear decay per second. */
const TRAUMA_DECAY = 1.6;
/** Max positional offset per axis at trauma=1, world units. */
const MAX_OFFSET = 0.16;
/** Max camera roll at trauma=1, radians (~2.3°). */
const MAX_ROT = 0.04;

/** Layered sin "noise" in [-1, 1]: sin(t·31) + 0.5·sin(t·47), normalized. */
function shakeNoise(t: number, phase: number): number {
  return (Math.sin(t * 31 + phase) + 0.5 * Math.sin(t * 47 + phase * 1.7)) / 1.5;
}

/** Frame sample: positional offset (world units) + roll (radians). */
export type ShakeSample = { ox: number; oy: number; rot: number };

export class TraumaCamera {
  private trauma = 0;
  private readonly phaseX = Math.random() * 100;
  private readonly phaseY = Math.random() * 100;
  private readonly phaseR = Math.random() * 100;

  /** Events add trauma; clamped so total shake time stays bounded. */
  add(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  reset(): void {
    this.trauma = 0;
  }

  /** Decay + sample the current frame's offset/roll. tSec = elapsed seconds. */
  update(dt: number, tSec: number): ShakeSample {
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    const shake = this.trauma * this.trauma;
    if (shake <= 0.0001) return { ox: 0, oy: 0, rot: 0 };
    return {
      ox: MAX_OFFSET * shake * shakeNoise(tSec, this.phaseX),
      oy: MAX_OFFSET * shake * shakeNoise(tSec, this.phaseY),
      rot: MAX_ROT * shake * shakeNoise(tSec, this.phaseR),
    };
  }
}
