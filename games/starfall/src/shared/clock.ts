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

let pausedTotal = 0; // total ms elapsed while paused, accumulated across pauses
let pausedAt = 0; // real timestamp the current pause began; 0 when not paused

/** Sim clock: `Date.now()` minus all time spent paused. Frozen while paused. */
export function now(): number {
  if (pausedAt !== 0) return pausedAt - pausedTotal;
  return Date.now() - pausedTotal;
}

/** Freeze the sim clock. Idempotent — a second call while paused is a no-op. */
export function pauseClock(): void {
  if (pausedAt !== 0) return;
  pausedAt = Date.now();
}

/** Resume the sim clock, folding the pause span into the running offset. */
export function resumeClock(): void {
  if (pausedAt === 0) return;
  pausedTotal += Date.now() - pausedAt;
  pausedAt = 0;
}
