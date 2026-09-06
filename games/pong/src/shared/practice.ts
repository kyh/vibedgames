/** Progress observes accepted contacts; it never arms a stroke or changes a shot. */
export type CurveProgress = "return" | "left" | "right" | "complete";
export type CurveLesson = "return" | "curve" | "complete";
export type PlayMode =
  | { readonly kind: "match" }
  | { readonly kind: "practice"; readonly progress: CurveProgress };

/** Strength is the accepted shot in the local screen frame, not raw input. */
export function advancePractice(progress: CurveProgress, screenStrength: number): CurveProgress {
  if (!Number.isFinite(screenStrength)) return progress;
  switch (progress) {
    case "return":
      return "left";
    case "left":
      return screenStrength <= -0.15 ? "right" : progress;
    case "right":
      return screenStrength >= 0.15 ? "complete" : progress;
    case "complete":
      return progress;
  }
}

/** One accepted curve also proves the player can return the ball. */
export function advanceLesson(lesson: CurveLesson, screenStrength: number): CurveLesson {
  if (lesson === "complete" || !Number.isFinite(screenStrength)) return lesson;
  return Math.abs(screenStrength) >= 0.15 ? "complete" : "curve";
}

export function practiceObjective(progress: CurveProgress): string {
  switch (progress) {
    case "return":
      return "1 / 3 · Return the ball";
    case "left":
      return "2 / 3 · Curve left at contact";
    case "right":
      return "3 / 3 · Curve right at contact";
    case "complete":
      return "3 / 3 · Both curves landed";
  }
}
