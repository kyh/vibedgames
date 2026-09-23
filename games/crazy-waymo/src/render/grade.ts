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
//   lens:   WRITER the trailer director, per shot. READER PostPipeline.
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
export const setGradeNight = (value: number): void => {
  night = value;
};

export const gradeNight = (): number => night;

/** 0 = neutral daylight .. 1 = full golden-hour warmth. DayNight.update only. */
export const setGradeWarmth = (value: number): void => {
  warmth = value;
};

export const gradeWarmth = (): number => warmth;

/**
 * Player motion for the speed-reactive lens: speed as a 0..1 fraction of the
 * boost top speed, plus the boost flag. GameScene.update only.
 */
export const setGradeMotion = (speedFrac: number, boosting: boolean): void => {
  motionSpeed = speedFrac;
  motionBoost = boosting;
};

export const gradeMotion = () => ({ boost: motionBoost, speed: motionSpeed });

/**
 * Cinematic lens for authored trailer cameras. `focus` is the view-space
 * distance kept sharp, `blur` the circle of confusion in pixels at infinity
 * (1080p-relative), `streaks` scales the speed-comb and radial rush, which
 * read as a HUD effect on a tripod or tracking lens. null restores the game
 * lens and costs nothing.
 */
export interface GradeLens {
  focus: number;
  blur: number;
  streaks: number;
}

let lens: GradeLens | null = null;

export const setGradeLens = (value: GradeLens | null): void => {
  lens = value;
};

export const gradeLens = (): GradeLens | null => lens;
