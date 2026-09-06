// Pausable wall clock for the sim.
//
// Bomb fuses, blast lifetimes, the round timer and AI cadence are all driven by
// wall-clock timestamps (compare a stored `placedAt`/`nextMoveAt` against the
// current time). Reading `Date.now()` directly makes those deadlines impossible
// to pause: sleeping the render loop stops `update()`, but every stored fuse
// keeps counting against real time, so on resume they all detonate at once.
//
// `now()` is real time minus every millisecond spent paused. While paused it
// holds still; on resume it continues from exactly where it stopped, so a bomb
// with 2s of fuse left before a pause still has ~2s left after. Only SIM timing
// reads `now()` — net heartbeats, connection deadlines and logging stay on real
// `Date.now()`, because pausing them would break reconnection.

export type ClockStamp = { kind: "running"; offset: number } | { kind: "paused"; now: number };
type ClockWire = string | number | boolean | null | ClockWire[] | { [key: string]: ClockWire };

let clock: ClockStamp = { kind: "running", offset: 0 };

const isRecord = (value: ClockWire | undefined): value is { [key: string]: ClockWire } =>
  Object.prototype.toString.call(value) === "[object Object]";
const isFiniteNumber = (value: ClockWire | undefined): value is number => Number.isFinite(value);

/** Optional only at the legacy wire boundary. A frozen timestamp carries an
 * unfinished pause through host loss; an offset alone cannot represent it. */
export function readClock(value: ClockWire | undefined): ClockStamp {
  if (isRecord(value)) {
    if (value["kind"] === "running" && isFiniteNumber(value["offset"]))
      return { kind: "running", offset: value["offset"] };
    if (value["kind"] === "paused" && isFiniteNumber(value["now"]))
      return { kind: "paused", now: value["now"] };
  }
  return { kind: "running", offset: 0 };
}

export function clockStamp(): ClockStamp {
  return { ...clock };
}

export function adoptClock(stamp: ClockStamp): void {
  clock = { ...stamp };
}

export function sameClock(a: ClockStamp, b: ClockStamp): boolean {
  return a.kind === "paused"
    ? b.kind === "paused" && a.now === b.now
    : b.kind === "running" && a.offset === b.offset;
}

/** Sim clock: `Date.now()` minus all time spent paused. Frozen while paused. */
export function now(): number {
  return clock.kind === "paused" ? clock.now : Date.now() - clock.offset;
}

/** Freeze the sim clock. Idempotent — a second call while paused is a no-op. */
export function pauseClock(): void {
  if (clock.kind === "paused") return;
  clock = { kind: "paused", now: now() };
}

/** Resume the sim clock, folding the pause span into the running offset. */
export function resumeClock(): void {
  if (clock.kind === "running") return;
  clock = { kind: "running", offset: Date.now() - clock.now };
}
