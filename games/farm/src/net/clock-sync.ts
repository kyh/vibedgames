import { CLOCK_SNAP_MIN, DAY_END_MIN, GAME_MIN_PER_REAL_SEC } from "../config";
import { isJsonNumber } from "../json";
import type { JsonObject, JsonValue } from "../json";
import type { Weather } from "../systems/weather";

// The co-op clock. The host owns it and publishes it as primitive shared keys;
// a guest runs it locally between readings (so the HUD ticks minute by minute
// instead of jumping with each packet) and only steers back toward the host.

/** The host clock as it rides the wire. `running` is false while the host's
 *  clock stands still (a menu, a fade, a trip down the mine). */
export interface ClockReading {
  day: number;
  time: number;
  weather: Weather;
  running: boolean;
}

/** The clock fields a guest's follower drives (GameScene's own). */
export interface ClockState {
  day: number;
  timeMin: number;
  weather: Weather;
}

/** A host reading that moved this farmer to another day. */
export interface DayTurn {
  /** The host's day is past ours, so this farmer slept through a night too. */
  rested: boolean;
  /** That night began at the 2am cutoff: the farmer stayed up and passed out. */
  exhausted: boolean;
}

/** Small drift is absorbed by running the clock at most this much fast or slow. */
const SLEW = 0.25;

const isWeather = (v: JsonValue | undefined): v is Weather =>
  v === "sunny" || v === "rain" || v === "storm" || v === "snow";

export const clockPatch = (c: ClockReading): JsonObject => ({
  cd: c.day,
  cr: c.running,
  ct: Math.round(c.time * 10) / 10,
  cw: c.weather,
});

export const readClock = (shared: JsonObject): ClockReading | null => {
  const { cd: day, cr: running, ct: time, cw: weather } = shared;
  if (!isJsonNumber(day) || !isJsonNumber(time) || !isWeather(weather)) {
    return null;
  }
  if (running !== true && running !== false) {
    return null;
  }
  return { day, running, time, weather };
};

const sameReading = (a: ClockReading, b: ClockReading): boolean =>
  a.day === b.day && a.time === b.time && a.weather === b.weather && a.running === b.running;

/** A guest's copy of the host clock. */
export class ClockFollower {
  private running = false;
  /** Game-minutes the local clock still has to gain (or lose) on the host's. */
  private owed = 0;
  private last: ClockReading | null = null;

  /**
   * Fold in a host reading — call it whenever the shared state changes; a
   * reading already seen is ignored, since the local clock has run on since.
   * Returns the day turn when the reading moved `state` to another day.
   */
  observe(state: ClockState, reading: ClockReading): DayTurn | null {
    const { last } = this;
    if (last && sameReading(last, reading)) {
      return null;
    }
    this.last = reading;
    this.running = reading.running;
    state.weather = reading.weather;
    if (reading.day !== state.day) {
      const rested = reading.day > state.day;
      // The host's last reading of the old day says when that night began.
      const lateAt = Math.max(state.timeMin, last?.time ?? 0);
      state.day = reading.day;
      state.timeMin = reading.time;
      this.owed = 0;
      return { exhausted: rested && lateAt >= DAY_END_MIN - 1, rested };
    }
    const error = reading.time - state.timeMin;
    if (Math.abs(error) > CLOCK_SNAP_MIN) {
      state.timeMin = reading.time;
      this.owed = 0;
    } else {
      this.owed = error;
    }
    return null;
  }

  /** Run the clock on between readings. It stops at the 2am cutoff: only the
   *  host ends the day, and its new day arrives as a reading. */
  advance(state: ClockState, dtSec: number): void {
    if (!this.running) {
      return;
    }
    const step = dtSec * GAME_MIN_PER_REAL_SEC;
    const bend = Math.max(-step * SLEW, Math.min(step * SLEW, this.owed));
    this.owed -= bend;
    state.timeMin = Math.min(DAY_END_MIN, state.timeMin + step + bend);
  }

  /** Forget the host's clock — a different host's readings start afresh. */
  reset(): void {
    this.running = false;
    this.owed = 0;
    this.last = null;
  }
}
