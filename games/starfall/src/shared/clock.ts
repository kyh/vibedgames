let pausedTotal = 0;
let pausedAt = 0;

/** Sim clock: `Date.now()` minus all time spent paused. Frozen while paused. */
export const now = () => {
  if (pausedAt !== 0) {
    return pausedAt - pausedTotal;
  }

  return Date.now() - pausedTotal;
};

/** Freeze the sim clock. Idempotent — a second call while paused is a no-op. */
export const pauseClock = () => {
  if (pausedAt !== 0) {
    return;
  }

  pausedAt = Date.now();
};

/** Resume the sim clock, folding the pause span into the running offset. */
export const resumeClock = () => {
  if (pausedAt === 0) {
    return;
  }

  pausedTotal += Date.now() - pausedAt;
  pausedAt = 0;
};
