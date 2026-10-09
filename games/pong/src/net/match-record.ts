// The one thing the host decides: who sits where, from which tick, on which
// seed. It rides shared state under RECORD_KEY, is published only when the
// pairing changes or a timeline has to be re-based, and is everything a
// client needs to build the opening state on its own — the match itself then
// runs on the tick stream, the same on every client, whoever is host.

import type { JsonRecord, JsonValue } from "@vibedgames/multiplayer";

import type { Slot } from "../shared/sim";
import { isJsonNumber, isJsonObject, isJsonString } from "./session";

export const RECORD_KEY = "match";

export interface MatchRecord {
  /** Grows with every record the room publishes. */
  id: number;
  /** The tick clock it counts in: a restarted room starts a new one. */
  epoch: number;
  /** The player ids seated in slot A and slot B. */
  a: string;
  b: string;
  /** The match's first tick; its opening state stands at start − 1. */
  start: number;
  seed: number;
  /** The score it opens at — a re-base carries the old one over. */
  scoreA: number;
  scoreB: number;
}

const isWhole = (v: JsonValue | undefined): v is number =>
  isJsonNumber(v) && Number.isSafeInteger(v);

/** The room's record, or null when there is none (or it is not one). */
export const readRecord = (shared: JsonRecord): MatchRecord | null => {
  const raw = shared[RECORD_KEY];
  if (!isJsonObject(raw)) {
    return null;
  }
  const { a, b, epoch, id, scoreA, scoreB, seed, start } = raw;
  if (!isJsonString(a) || !isJsonString(b) || a === b) {
    return null;
  }
  if (!isJsonNumber(epoch) || !isWhole(id) || !isWhole(start) || !isWhole(seed)) {
    return null;
  }
  if (!isWhole(scoreA) || !isWhole(scoreB) || scoreA < 0 || scoreB < 0) {
    return null;
  }
  return { a, b, epoch, id, scoreA, scoreB, seed, start };
};

export const recordJson = (record: MatchRecord): JsonRecord => ({
  a: record.a,
  b: record.b,
  epoch: record.epoch,
  id: record.id,
  scoreA: record.scoreA,
  scoreB: record.scoreB,
  seed: record.seed,
  start: record.start,
});

/** The slot `id` is seated in, or null. */
export const seatOf = (record: MatchRecord, id: string | null): Slot | null => {
  if (id === record.a) {
    return 0;
  }
  return id === record.b ? 1 : null;
};

/** The id seated in the other slot. */
export const rivalOf = (record: MatchRecord, slot: Slot): string =>
  slot === 0 ? record.b : record.a;

/**
 * Seats for a pairing of `players`: anyone the current record already seats
 * keeps that slot (so nobody's view flips under them), and otherwise the host
 * takes slot A. Returns [slot A, slot B].
 */
export const seatPair = (
  current: MatchRecord | null,
  players: readonly [string, string],
  host: string,
): [string, string] => {
  const [first, second] = players;
  const other = first === host ? second : first;
  if (current !== null) {
    const kept = players.find((id) => id === current.a || id === current.b);
    if (kept !== undefined) {
      const rest = kept === first ? second : first;
      return kept === current.a ? [kept, rest] : [rest, kept];
    }
  }
  return [host, other];
};
