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
//
// The host publishes its stamp in shared state: every `placedAt` on the wire is
// host sim time, so guests (and a promoted host) must run the same clock. The
// stamp carries the host's sim time at the moment it was written, never its
// wall-clock offset — two machines disagree about `Date.now()` by seconds, and a
// guest calibrating against the host's offset would render every fuse shifted
// by that skew. Calibrating to the stamp on arrival leaves only one-way latency.

export type ClockStamp = { kind: "running"; at: number } | { kind: "paused"; now: number };

type Clock = { kind: "running"; offset: number } | { kind: "paused"; now: number };

/** Re-calibrations within this band are latency jitter, not drift: keep the
 * current offset so fuses do not wobble with every snapshot. */
export const CLOCK_SLACK_MS = 120;

let clock: Clock = { kind: "running", offset: 0 };
/** The `at` of the last running stamp adopted, so re-reading the same stamp
 * later (every room change re-runs adoption) cannot re-calibrate against a
 * stale write time and jump the sim backwards. */
let adoptedAt: number | null = null;

/** Legacy rooms carry no usable stamp: keep this client's own running clock.
 * A frozen `now` survives host loss where an offset alone could not represent
 * an unfinished pause. */
export function readClock(value: ClockStamp | undefined): ClockStamp | null {
  if (value?.kind === "paused" && Number.isFinite(value.now)) {
    return { kind: "paused", now: value.now };
  }
  if (value?.kind === "running" && Number.isFinite(value.at)) {
    return { kind: "running", at: value.at };
  }
  return null;
}

export function clockStamp(): ClockStamp {
  return clock.kind === "paused" ? clock : { at: now(), kind: "running" };
}

/** Follow the host's stamp. A running stamp calibrates local sim time to the
 * host's as of `receivedAt`; a paused one freezes at the host's frozen time. */
export function adoptClock(stamp: ClockStamp | null, receivedAt = Date.now()): void {
  if (!stamp) {
    return;
  }
  if (stamp.kind === "paused") {
    clock = stamp;
    adoptedAt = null;
    return;
  }
  if (stamp.at === adoptedAt) {
    return;
  }
  adoptedAt = stamp.at;
  const offset = receivedAt - stamp.at;
  if (clock.kind === "running" && Math.abs(clock.offset - offset) <= CLOCK_SLACK_MS) {
    return;
  }
  clock = { kind: "running", offset };
}

/** Sim clock: `Date.now()` minus all time spent paused. Frozen while paused. */
export function now(): number {
  return clock.kind === "paused" ? clock.now : Date.now() - clock.offset;
}

/** Freeze the sim clock. Idempotent — a second call while paused is a no-op. */
export function pauseClock(): void {
  if (clock.kind === "paused") {
    return;
  }
  clock = { kind: "paused", now: now() };
}

/** Resume the sim clock, folding the pause span into the running offset. */
export function resumeClock(): void {
  if (clock.kind === "running") {
    return;
  }
  clock = { kind: "running", offset: Date.now() - clock.now };
}
