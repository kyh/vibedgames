// The shared course's scroll as a function of the room's clock. Free of
// Phaser so tools/net.test.mts can drive it headless.

import { PIPE_SPEED } from "../shared/constants";

/**
 * A flying dragon's course this far behind where it stood is not a hitch but
 * another course position (back from a blip into a race the host held), and
 * is adopted in one frame. One trunk spacing.
 */
export const COURSE_SNAP_PX = 400;

/** The scroll at room time `now` of a race that started at room time `start`. */
export const courseX = (start: number, now: number): number => (PIPE_SPEED * (now - start)) / 1000;

/** The start that puts the scroll at `x` at room time `now`: a race that carries a course on from where it stands. */
export const courseStart = (x: number, now: number): number =>
  Math.round(now - (1000 * x) / PIPE_SPEED);

/**
 * This frame's scroll for a client at `prev` whose room says `target`. A
 * flying dragon never sees the pipes run backwards: a course a little behind
 * holds still until the room's catches up, and only one a trunk spacing or
 * more behind is adopted outright. Ahead, or not flying, the room's wins at once.
 */
export const followCourse = (prev: number, target: number, flying: boolean): number =>
  flying && target < prev && prev - target < COURSE_SNAP_PX ? prev : target;
