let night = 0;
let warmth = 0;
let motionSpeed = 0;
let motionBoost = false;

/** 0 = broad daylight .. 1 = full night. Called by DayNight.update only. */
export const setGradeNight = (value: number) => {
  night = value;
};

export const gradeNight = () => night;

/** 0 = neutral daylight .. 1 = full golden-hour warmth. DayNight.update only. */
export const setGradeWarmth = (value: number) => {
  warmth = value;
};

export const gradeWarmth = () => warmth;

/**
 * Player motion for the speed-reactive lens: speed as a 0..1 fraction of the
 * boost top speed, plus the boost flag. GameScene.update only.
 */
export const setGradeMotion = (speedFrac: number, boosting: boolean) => {
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

export const setGradeLens = (value: GradeLens | null) => {
  lens = value;
};

export const gradeLens = () => lens;
