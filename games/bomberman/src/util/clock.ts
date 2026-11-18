import type { SenderClock } from "@vibedgames/multiplayer";

export type ClockStamp = { kind: "running"; offset: number } | { kind: "paused"; now: number };

/** This machine's clock, on the server's epoch: the base until the scene sets the room's. */
export const localClock: SenderClock = {
  now: (localNow = performance.now()) => performance.timeOrigin + localNow,
  synced: true,
};

let base: SenderClock = localClock;
let clock: ClockStamp = { kind: "running", offset: 0 };

/** Run sim time on `source`: the room's clock, `client.serverClock`. */
export const setClockBase = (source: SenderClock) => {
  base = source;
};

/** A stamp off the wire, or null when it is not one. */
export const readClock: (value?: ClockStamp) => ClockStamp | null = (value?) => {
  if (value?.kind === "paused" && Number.isFinite(value.now)) {
    return { kind: "paused", now: value.now };
  }

  if (value?.kind === "running" && Number.isFinite(value.offset)) {
    return { kind: "running", offset: value.offset };
  }

  return null;
};

/** Sim time at local time `localNow` (default: now). Frozen while paused. */
export const now = (localNow?: number) =>
  clock.kind === "paused" ? clock.now : base.now(localNow) - clock.offset;

/** The sim clock as a `StepTrack` reads one: bots step on it. */
export const simClock: SenderClock = {
  now,
  get synced() {
    return base.synced;
  },
};

export const clockStamp = () => clock;

/** Follow the room's stamp. Every client shares the base, so it applies as is. */
export const adoptClock = (stamp: ClockStamp | null) => {
  if (stamp) {
    clock = stamp;
  }
};

/** Freeze the sim clock. Idempotent: a second call while paused is a no-op. */
export const pauseClock = () => {
  if (clock.kind === "running") {
    clock = { kind: "paused", now: now() };
  }
};

/** Resume the sim clock, folding the paused span into the offset. */
export const resumeClock = () => {
  if (clock.kind === "paused") {
    clock = { kind: "running", offset: base.now() - clock.now };
  }
};
