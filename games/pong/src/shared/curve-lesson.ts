/** Passive teaching observes accepted contacts; it never changes a shot. */
export type CurveLesson = "return" | "curve" | "complete";

/** One accepted curve also proves the player can return the ball. */
export function advanceLesson(lesson: CurveLesson, screenStrength: number): CurveLesson {
  if (lesson === "complete" || !Number.isFinite(screenStrength)) return lesson;
  return Math.abs(screenStrength) >= 0.15 ? "complete" : "curve";
}
