// The timing rules that keep the host's ball and a guest's local copy of it on
// one timeline. Slot B's returns, while a human guest holds it, are the
// guest's call: it judges contacts on its own paddle against that paddle as
// it is now; the host parks the ball at the near edge of B's hit band until
// the verdict lands, checks a claimed hit against its own copy of the flight,
// and replays it from the contact, caught up to now. The guest carries each
// host snapshot forward on the host's clock the same way. Pure, so the timing
// is testable without a scene or a socket. Times are host seconds.

import { advanceFlight, copyFlight } from "./ball";
import type { Flight } from "./ball";
import {
  HIT_HALF_X,
  HIT_HALF_Y,
  HIT_STOP_PADDLE,
  PADDLE_X_MAX,
  PADDLE_Y,
  VERDICT_HOLD_MAX_S,
  VERDICT_SLACK,
} from "./constants";

/** The near edge of slot B's hit band: a ball awaiting B's verdict parks here. */
export const HOLD_Y = PADDLE_Y - HIT_HALF_Y;

/** How far past the band's edges a claimed contact's y may sit (wire rounding). */
const BAND_SLACK = 0.1;
/** Claims travel rounded to a thousandth; an edge graze must survive that. */
const WIRE_EPS = 0.001;

/** Longest a ball is carried forward in one go — far past any age a live
 *  connection produces; it bounds the replay after a stall. */
export const MAX_CATCH_UP_S = 0.5;

/** Between the two hit bands, where no paddle is deciding anything. */
export const inOpenCourt = (y: number): boolean => Math.abs(y) < HOLD_Y;

/**
 * Guest: a host snapshot's ball carried `age` seconds forward on the host's
 * clock — holding through the `held` seconds of hit-stop it still owed — to
 * the moment the guest's own copy is at.
 */
export const projectFlight = (snap: Flight, age: number, held: number): Flight => {
  const ball = copyFlight(snap);
  advanceFlight(ball, Math.min(MAX_CATCH_UP_S, Math.max(0, age - held)));
  return ball;
};

/** The ball as it reached B's band, and when. */
export interface Hold {
  at: number;
  flight: Flight;
}

/** A guest's claimed return: where the ball met its paddle, and the paddle. */
export interface HitClaim {
  x: number;
  y: number;
  paddle: number;
}

/**
 * Park a ball whose last step carried it past HOLD_Y back on that line, and
 * record when it crossed — `now` minus the overshoot, so the frame rate
 * never shifts the timeline.
 */
export const parkAtBand = (ball: Flight, now: number): Hold => {
  const over = Math.max(0, (ball.pos.y - HOLD_Y) / ball.vel.y);
  ball.pos.x -= ball.vel.x * over;
  ball.pos.y = HOLD_Y;
  return { at: now - over, flight: copyFlight(ball) };
};

/**
 * The hold a ball still short of the band is about to make — for a verdict
 * that outran the host's own copy of the flight. Null unless the ball is on
 * its way into the band and close.
 */
export const holdAhead = (ball: Flight, now: number): Hold | null => {
  if (ball.vel.y <= 0 || ball.pos.y > HOLD_Y) {
    return null;
  }
  const ahead = (HOLD_Y - ball.pos.y) / ball.vel.y;
  if (ahead > VERDICT_HOLD_MAX_S) {
    return null;
  }
  const flight = copyFlight(ball);
  advanceFlight(flight, ahead);
  return { at: now + ahead, flight };
};

/**
 * When a claimed return met the ball, or null when the claim does not fit
 * the host's own copy of the flight: outside B's band, off the flight's
 * line, or a paddle nowhere near its own contact.
 */
export const judgeClaim = (hold: Hold, claim: HitClaim): number | null => {
  const { flight } = hold;
  const depth = claim.y - flight.pos.y;
  if (depth < -BAND_SLACK || depth > 2 * HIT_HALF_Y + BAND_SLACK) {
    return null;
  }
  if (
    Math.abs(claim.paddle) > PADDLE_X_MAX + WIRE_EPS ||
    Math.abs(claim.x - claim.paddle) >= HIT_HALF_X + WIRE_EPS
  ) {
    return null;
  }
  const since = Math.max(0, depth) / flight.vel.y;
  const path = copyFlight(flight);
  advanceFlight(path, since);
  if (Math.abs(path.pos.x - claim.x) > VERDICT_SLACK) {
    return null;
  }
  return hold.at + since;
};

/**
 * Carry a ball that left a paddle `since` seconds ago up to now, the way
 * every copy of it moved: held for the paddle hit-stop, then in flight.
 * Returns the hit-stop still owed — 0 once the contact is older than that.
 */
export const resumeFromContact = (ball: Flight, since: number): number => {
  const run = Math.max(0, since) - HIT_STOP_PADDLE;
  if (run <= 0) {
    return -run;
  }
  advanceFlight(ball, run);
  return 0;
};
