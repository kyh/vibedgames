// Trauma-based camera shake (Eiserloh, GDC 2016). Events ADD trauma; shake
// magnitude = trauma², sampled from layered sin noise per axis. Offsets are in
// world units (applied along the camera's right/up after lookAt) plus a small
// roll. Copied from pacman, retuned a touch punchier for Tetris impacts.

const TRAUMA_DECAY = 1.7;
const MAX_OFFSET = 0.22;
const MAX_ROLL = 0.05;

function shakeNoise(t: number, phase: number): number {
  return (Math.sin(t * 31 + phase) + 0.5 * Math.sin(t * 47 + phase * 1.7)) / 1.5;
}

export type ShakeSample = { ox: number; oy: number; roll: number };

export class TraumaCamera {
  private trauma = 0;
  private readonly phaseX = Math.random() * 100;
  private readonly phaseY = Math.random() * 100;
  private readonly phaseR = Math.random() * 100;

  add(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  reset(): void {
    this.trauma = 0;
  }

  update(dt: number, tSec: number): ShakeSample {
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    const shake = this.trauma * this.trauma;
    if (shake <= 0.0001) return { ox: 0, oy: 0, roll: 0 };
    return {
      ox: MAX_OFFSET * shake * shakeNoise(tSec, this.phaseX),
      oy: MAX_OFFSET * shake * shakeNoise(tSec, this.phaseY),
      roll: MAX_ROLL * shake * shakeNoise(tSec, this.phaseR),
    };
  }
}
