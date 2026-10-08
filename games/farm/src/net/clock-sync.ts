import { DAY_END_MIN, GAME_MIN_PER_REAL_SEC } from "../config";
import { isJsonNumber } from "../json";
import type { JsonObject, JsonValue } from "../json";
import type { Weather } from "../systems/weather";

// The co-op clock. The host owns it and publishes an anchor — the game time it
// read at a server-time instant, and whether it runs on from there — only when
// it starts, stops or turns a day. Every client, the host included, reads the
// minute off that anchor and the room's server clock, so all of them show the
// same time with nothing relayed in between and nothing to steer back.

/** The host clock as it rides the wire: `time` game-minutes at server time
 *  `at`, running on from there unless the host's clock stands still (a menu,
 *  a fade, a trip down the mine). */
export interface ClockAnchor {
  day: number;
  time: number;
  at: number;
  running: boolean;
  weather: Weather;
}

/** The clock fields a guest's day turn reads (GameScene's own). */
export interface ClockState {
  day: number;
  timeMin: number;
}

/** A host anchor that moved this farmer to another day. */
export interface DayTurn {
  /** The host's day is past ours, so this farmer slept through a night too. */
  rested: boolean;
  /** That night began at the 2am cutoff: the farmer stayed up and passed out. */
  exhausted: boolean;
}

const isWeather = (v: JsonValue | undefined): v is Weather =>
  v === "sunny" || v === "rain" || v === "storm" || v === "snow";

/** The host's anchor for the clock as it stands at server time `now`. Rounded
 *  as it rides the wire, so the host reads exactly what its guests read. */
export const anchorClock = (
  day: number,
  time: number,
  weather: Weather,
  running: boolean,
  now: number,
): ClockAnchor => ({
  at: Math.round(now),
  day,
  running,
  time: Math.round(time * 10) / 10,
  weather,
});

/** The game time an anchor reads at server time `now`. It stops at the 2am
 *  cutoff — only the host ends the day — and never reads earlier than the
 *  anchor itself, whatever a reader's clock error. */
export const clockTime = (a: ClockAnchor, now: number): number =>
  a.running
    ? Math.min(DAY_END_MIN, a.time + (Math.max(0, now - a.at) / 1000) * GAME_MIN_PER_REAL_SEC)
    : a.time;

export const clockPatch = (a: ClockAnchor): JsonObject => ({
  ca: a.at,
  cd: a.day,
  cr: a.running,
  ct: a.time,
  cw: a.weather,
});

export const readClock = (shared: JsonObject): ClockAnchor | null => {
  const { ca: at, cd: day, cr: running, ct: time, cw: weather } = shared;
  if (!isJsonNumber(at) || !isJsonNumber(day) || !isJsonNumber(time) || !isWeather(weather)) {
    return null;
  }
  if (running !== true && running !== false) {
    return null;
  }
  return { at, day, running, time, weather };
};

/** A guest meeting a host anchor: the day turn when it moves `state` to
 *  another day. `state.timeMin` is still the old day's last minute, which says
 *  whether that night began at the 2am cutoff. */
export const turnDay = (state: ClockState, anchor: ClockAnchor): DayTurn | null => {
  if (anchor.day === state.day) {
    return null;
  }
  const rested = anchor.day > state.day;
  return { exhausted: rested && state.timeMin >= DAY_END_MIN - 1, rested };
};
