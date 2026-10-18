// The driver that follows a Navigator readout: steering towards the route
// ahead, pedals from the corners it allows, and backing out of a wall. Shared
// by `vg playtest run` (src/playtest/install.ts turns its output into keys)
// and the in-game map's click-to-drive, which feeds it to the car directly.
import type { CarInput } from "../vehicle/car";
import type { NavReadout, PlaytestView } from "./navigator";

/** What the pilot reads each frame. */
export interface PilotState {
  readonly phase: PlaytestView["phase"];
  /** Signed forward speed, units/s. */
  readonly speed: number;
  readonly stuckSeconds: number;
  readonly boostReady: boolean;
  readonly nav: NavReadout | null;
}

export const STUCK_AFTER = 1;
const REVERSE_MS = 1300;
const STEER_DEADBAND_DEG = 3;
const STEER_FULL_DEG = 14;
// Lifting off only sheds 22 u/s²; on a descent gravity adds more than that.
const BRAKE_MARGIN = 3;
const DRIFT_MIN_SPEED = 9;

const IDLE: CarInput = { boost: false, brake: 0, steer: 0, throttle: 0 };

/** Heading error as a wheel position, + = right. Reversing swaps which way the nose swings. */
const steerFor = (errorDeg: number, reversing: boolean): number => {
  const size = Math.abs(errorDeg);
  if (size < STEER_DEADBAND_DEG) {
    return 0;
  }
  const amount = Math.min(1, size / STEER_FULL_DEG);
  const left = errorDeg > 0 !== reversing;
  return left ? -amount : amount;
};

const pedals = (state: PilotState, nav: NavReadout): CarInput => {
  // Facing the wrong way: crawl round rather than power into the far kerb.
  const limit =
    Math.abs(nav.headingErrorDeg) > 60 ? Math.min(nav.targetSpeed, 10) : nav.targetSpeed;
  // Brake + steer is this game's drift: the tail steps out and the line is
  // gone. The brake sheds 82 u/s², so the pilot straightens for the instant
  // it takes, then steers again.
  const braking = state.speed > limit + BRAKE_MARGIN;
  if (braking && state.speed > DRIFT_MIN_SPEED) {
    return { ...IDLE, brake: 1 };
  }
  const steer = steerFor(nav.headingErrorDeg, state.speed < -0.5);
  if (braking) {
    return { ...IDLE, brake: 1, steer };
  }
  return { ...IDLE, steer, throttle: state.speed < limit ? 1 : 0 };
};

export class Autopilot {
  private reverseUntil = 0;
  private reverseFrom = 0;
  private lockLeft = false;

  /**
   * Backing out, and when that goes nowhere (a wall ahead, a hill behind) full
   * lock forwards instead: the nose slides along the wall until it clears.
   * The lock swaps side each attempt — the route's side may be the wall's.
   */
  reverseOut(state: PilotState): CarInput {
    if (state.phase !== "playing") {
      return IDLE;
    }
    const error = state.nav?.headingErrorDeg ?? 0;
    const now = performance.now();
    if (this.reverseFrom === 0 || now - this.reverseFrom > REVERSE_MS * 2) {
      this.reverseFrom = now;
      this.lockLeft = !this.lockLeft;
    }
    const backing = now - this.reverseFrom < REVERSE_MS * 0.6 || state.speed < -1;
    if (backing) {
      return { boost: false, brake: 1, steer: steerFor(error, true), throttle: 0 };
    }
    return { boost: false, brake: 0, steer: this.lockLeft ? -1 : 1, throttle: 1 };
  }

  /** Follow `state.nav`; `boost` spends the meter on open straights. */
  drive(state: PilotState, boost: boolean): CarInput {
    const { nav } = state;
    if (!nav || state.phase !== "playing") {
      return IDLE;
    }
    const now = performance.now();
    if (state.stuckSeconds >= STUCK_AFTER && now > this.reverseUntil + REVERSE_MS) {
      this.reverseUntil = now + REVERSE_MS;
    }
    if (now < this.reverseUntil) {
      return this.reverseOut(state);
    }
    const input = pedals(state, nav);
    const open =
      nav.turnAheadDeg < 12 && Math.abs(nav.headingErrorDeg) < 8 && nav.routeDistance > 120;
    if (boost && open && state.boostReady && nav.blocker === null) {
      return { ...input, boost: true };
    }
    return input;
  }
}
