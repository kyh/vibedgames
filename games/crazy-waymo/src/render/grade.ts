// One-way signals from the simulation to the post-processing grade.
//
// PostPipeline is built with (renderer, scene, camera) and rendered with no
// arguments, so there is no per-frame call site to thread state through —
// and adding one would mean the scene owner re-deriving state its systems
// already compute every frame. This module is that seam, and the contract is
// deliberately one-directional per signal:
//
//   night:  WRITER DayNight.update(), once a frame. READER PostPipeline.
//   warmth: WRITER DayNight.update(), once a frame. READER PostPipeline.
//   motion: WRITER GameScene.update(), once a frame. READER PostPipeline.
//
// Kept as function pairs rather than exported mutable objects so no consumer
// can hold a reference and quietly become a second writer.
//
// `warmth` exists because `night` is the LAMP factor, which is 0 at golden
// hour by design (lamps wait for sunset) — the warm-grade ramp needs its own
// per-stop channel, not a re-reading of the lamps.

let night = 0;
let warmth = 0;
let motionSpeed = 0;
let motionBoost = false;

/** 0 = broad daylight .. 1 = full night. Called by DayNight.update only. */
export function setGradeNight(value: number): void {
  night = value;
}

export function gradeNight(): number {
  return night;
}

/** 0 = neutral daylight .. 1 = full golden-hour warmth. DayNight.update only. */
export function setGradeWarmth(value: number): void {
  warmth = value;
}

export function gradeWarmth(): number {
  return warmth;
}

/**
 * Player motion for the speed-reactive lens: speed as a 0..1 fraction of the
 * boost top speed, plus the boost flag. GameScene.update only.
 */
export function setGradeMotion(speedFrac: number, boosting: boolean): void {
  motionSpeed = speedFrac;
  motionBoost = boosting;
}

export function gradeMotion() {
  return { speed: motionSpeed, boost: motionBoost };
}
