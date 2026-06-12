// Trauma-based screen shake (Eiserloh, GDC 2016): events ADD trauma, shake
// magnitude = trauma², sampled from layered sin noise per axis at full frame
// rate. Replaces fixed camera.shake calls, which fight each other; trauma
// stacks naturally and decays linearly.

/** Linear decay per second. */
const TRAUMA_DECAY = 1.5;
/** Max positional offset per axis at trauma=1, px. */
const MAX_OFFSET = 14;
/** Max camera roll at trauma=1, degrees. */
const MAX_ROT_DEG = 5;

/** Layered sin "noise" in [-1, 1]: sin(t·31) + 0.5·sin(t·47), normalized. */
function shakeNoise(t: number, phase: number): number {
  return (Math.sin(t * 31 + phase) + 0.5 * Math.sin(t * 47 + phase * 1.7)) / 1.5;
}

export type ShakeSample = { ox: number; oy: number; rotDeg: number };

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

  /** Decay + sample the current frame's offset/rotation. tSec = scene time. */
  update(dt: number, tSec: number): ShakeSample {
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    const shake = this.trauma * this.trauma;
    if (shake <= 0.0001) return { ox: 0, oy: 0, rotDeg: 0 };
    return {
      ox: MAX_OFFSET * shake * shakeNoise(tSec, this.phaseX),
      oy: MAX_OFFSET * shake * shakeNoise(tSec, this.phaseY),
      rotDeg: MAX_ROT_DEG * shake * shakeNoise(tSec, this.phaseR),
    };
  }
}
