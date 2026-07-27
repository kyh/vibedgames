// One-way signal from the day-night rig to the post-processing grade.
//
// PostPipeline is built with (renderer, scene, camera) and rendered with no
// arguments, so there is no per-frame call site to thread the cycle through —
// and adding one would mean the scene owner re-deriving state DayNight already
// computes every frame. This module is that seam, and the contract is
// deliberately one-directional:
//
//   WRITER: DayNight.update(), once a frame. Nothing else.
//   READER: PostPipeline.render(). Nothing else.
//
// Kept as a function pair rather than an exported mutable object so no consumer
// can hold a reference and quietly become a second writer.

let night = 0;

/** 0 = broad daylight .. 1 = full night. Called by DayNight.update only. */
export function setGradeNight(value: number): void {
  night = value;
}

export function gradeNight(): number {
  return night;
}
