// Sim time: the room's shared clock, minus every millisecond spent paused.
//
// Bomb fuses, blast lifetimes, the round id and bot cadence are timestamps on
// this clock (compare a stored `placedAt`/`nextMoveAt` against `now()`).
// Its base is the room's clock (`client.serverClock`). Online that is the party
// server's, which every client measures for itself, so a stamp means the same
// instant to every player and a new host changes nothing. Offline it is this
// machine's own.
//
// Pausing a solo arena freezes it: `now()` holds still, and on resume the
// paused span joins the offset, so a bomb with 2 s of fuse left before a pause
// still has ~2 s after. The host publishes its stamp (the offset, or the frozen
// time) whenever it changes, and every other client adopts it as is: nothing
// is estimated from when it arrived. Only sim timing reads `now()`; net
// heartbeats, connection deadlines and logging stay on real `Date.now()`,
// because pausing those would break reconnection.

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
export const setClockBase = (source: SenderClock): void => {
  base = source;
};

/** A stamp off the wire, or null when it is not one. */
export const readClock = (value?: ClockStamp): ClockStamp | null => {
  if (value?.kind === "paused" && Number.isFinite(value.now)) {
    return { kind: "paused", now: value.now };
  }
  if (value?.kind === "running" && Number.isFinite(value.offset)) {
    return { kind: "running", offset: value.offset };
  }
  return null;
};

/** Sim time at local time `localNow` (default: now). Frozen while paused. */
export const now = (localNow?: number): number =>
  clock.kind === "paused" ? clock.now : base.now(localNow) - clock.offset;

/** The sim clock as a `StepTrack` reads one: bots step on it. */
export const simClock: SenderClock = {
  now,
  get synced() {
    return base.synced;
  },
};

export const clockStamp = (): ClockStamp => clock;

/** True when two stamps say the same thing: the host sends its stamp only when it changes. */
export const sameStamp = (a: ClockStamp | undefined, b: ClockStamp): boolean => {
  if (a?.kind === "paused" && b.kind === "paused") {
    return a.now === b.now;
  }
  return a?.kind === "running" && b.kind === "running" && a.offset === b.offset;
};

/** Follow the room's stamp. Every client shares the base, so it applies as is. */
export const adoptClock = (stamp: ClockStamp | null): void => {
  if (stamp) {
    clock = stamp;
  }
};

/** Freeze the sim clock. Idempotent: a second call while paused is a no-op. */
export const pauseClock = (): void => {
  if (clock.kind === "running") {
    clock = { kind: "paused", now: now() };
  }
};

/** Resume the sim clock, folding the paused span into the offset. */
export const resumeClock = (): void => {
  if (clock.kind === "paused") {
    clock = { kind: "running", offset: base.now() - clock.now };
  }
};
