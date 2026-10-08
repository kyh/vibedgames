// A guest's movement and aim on their way to the host. Movement travels as one
// of 32 compass directions, so a thumb stick sweeping a few degrees does not
// stream a message every frame. The guest moves its own body by exactly the
// direction it last sent, never by the raw stick, so the host replays the same
// input the prediction ran and the two copies cannot drift apart over it.
import type { JsonObject, JsonValue } from "../json";
import { isJsonNumber } from "../json";
import { INPUT_HZ } from "./protocol";

export const DIRECTIONS = 32;
/** No direction: standing still. */
export const STILL = -1;
const STEP = (Math.PI * 2) / DIRECTIONS;
/** Look angles travel in hundredths of a radian. */
const LOOK_SCALE = 100;
/** While moving or aiming, an unchanged input is re-sent this often so a newly promoted host learns it. */
const REFRESH_MS = 500;
const MIN_GAP_MS = 1000 / INPUT_HZ;

export interface InputState {
  /** 0..31 clockwise from +z, or STILL. */
  dir: number;
  /** Passive facing in hundredths of a radian, or null when the player is not aiming. */
  look: number | null;
}

export interface Direction {
  x: number;
  z: number;
}

const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

/** The nearest of the 32 directions to a movement axis; a zero axis is STILL. */
export const quantizeDirection = (x: number, z: number): number => {
  if (Math.hypot(x, z) < 1e-6) {
    return STILL;
  }
  const index = Math.round(Math.atan2(x, z) / STEP);
  return ((index % DIRECTIONS) + DIRECTIONS) % DIRECTIONS;
};

/** The unit movement axis a direction stands for — identical on every client that decodes it. */
export const directionVector = (dir: number): Direction =>
  dir === STILL ? { x: 0, z: 0 } : { x: Math.sin(dir * STEP), z: Math.cos(dir * STEP) };

export const quantizeLook = (look: number | null): number | null =>
  look === null ? null : Math.round(wrapAngle(look) * LOOK_SCALE);

export const lookAngle = (look: number | null): number | null =>
  look === null ? null : wrapAngle(look / LOOK_SCALE);

const isInteger = (v: JsonValue | undefined): v is number => isJsonNumber(v) && Number.isInteger(v);

/** Out-of-range or non-integer directions read as standing still; invalid aim releases facing. */
export const parseInputState = (payload: JsonObject): InputState => {
  const { dir, look } = payload;
  return {
    dir: isInteger(dir) && dir >= 0 && dir < DIRECTIONS ? dir : STILL,
    look: isInteger(look) ? Math.round(wrapAngle(look / LOOK_SCALE) * LOOK_SCALE) : null,
  };
};

/**
 * Decides when a guest's input goes out: at most INPUT_HZ messages a second,
 * immediately on a change once that gap has passed, and refreshed every half
 * second while held. `applied` is what the host has been sent — the guest
 * moves by it, so a change held back by the rate cap moves neither copy.
 */
export class InputGate {
  applied: InputState = { dir: STILL, look: null };
  private sentAt = Number.NEGATIVE_INFINITY;
  private forced = true;

  due(next: InputState, now: number): boolean {
    const elapsed = now - this.sentAt;
    if (elapsed < MIN_GAP_MS) {
      return false;
    }
    if (this.forced || next.dir !== this.applied.dir || next.look !== this.applied.look) {
      return true;
    }
    return (next.dir !== STILL || next.look !== null) && elapsed >= REFRESH_MS;
  }

  mark(next: InputState, now: number): void {
    this.applied = next;
    this.sentAt = now;
    this.forced = false;
  }

  /** Send the current input at the next chance whether or not it changed (a new body, a new host). */
  force(): void {
    this.forced = true;
    this.sentAt = Number.NEGATIVE_INFINITY;
  }
}
