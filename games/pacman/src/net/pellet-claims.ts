// Pellets on the wire: one first-come claim per pellet per round, decided by
// the party server in one hop (`client.claim`), with no host round trip and no
// host edge — the host's own pac claims like everyone else's. Every client
// derives the same pellet list from the static MAP, and the board — which
// pellets are gone — is exactly this round's claims, plus our own eats still
// in flight. Claims outlive their owner and arrive in the join sync, so a late
// joiner, a promoted host and a player back from a dropped connection all read
// the same maze from them.
//
// The eater acts at once: the pellet vanishes and scores before the server
// answers. An answer naming someone else means they got there first — the
// pellet stays gone (it is theirs) and the eater hands back what it took.

import type { ClaimMap } from "@vibedgames/multiplayer";

import { MAP, cellKey } from "../shared/constants";

/** Pellet and heart cells in row-major order: claim index i is cell i. */
export const PELLET_CELLS: readonly string[] = MAP.flatMap((cells, row) =>
  cells.flatMap((type, col) => (type === 2 || type === 3 ? [cellKey(col, row)] : [])),
);
const CELL_INDEX = new Map(PELLET_CELLS.map((cell, index) => [cell, index]));

/** Every pellet claim starts with this; the host clears it for a new round. */
export const PELLET_CLAIM_PREFIX = "pellet:";

/**
 * The claim on `cell` in `round`, or null for a cell that holds no pellet.
 * Round-scoped: a claim that reaches the server after the host moved on is a
 * claim on a maze nobody shows any more, never on the new one.
 */
export const pelletClaimKey = (round: number, cell: string): string | null => {
  const index = CELL_INDEX.get(cell);
  return index === undefined ? null : `${PELLET_CLAIM_PREFIX}${round}:${index}`;
};

/** The cell a claim key eats in `round`, or null (another round, another kind of key, or junk). */
export const claimedCell = (key: string, round: number): string | null => {
  const prefix = `${PELLET_CLAIM_PREFIX}${round}:`;
  if (!key.startsWith(prefix)) {
    return null;
  }
  const digits = key.slice(prefix.length);
  const index = Number(digits);
  // Canonical integers only: "07", "1e2" or " 3" must not alias a cell.
  if (!Number.isInteger(index) || String(index) !== digits) {
    return null;
  }
  return PELLET_CELLS[index] ?? null;
};

/** An eat of ours someone else won: the pellet's cell, and what to hand back. */
export interface LostEat<T> {
  cell: string;
  undo: T;
}

interface PendingEat<T> {
  cell: string;
  /** What to hand back if the claim goes to someone else; null once forgiven. */
  undo: T | null;
  /** When the claim was last sent (local ms). */
  sentAt: number;
}

/**
 * This player's side of the race: eats claimed but not yet answered. Answers
 * are read off the room's claim map rather than one-off notices, so one that
 * landed while the transport was down still settles from the next sync.
 */
export class PelletClaims<T> {
  private readonly pending = new Map<string, PendingEat<T>>();

  /** Eats claimed and not yet answered. */
  get inFlight(): number {
    return this.pending.size;
  }

  /**
   * Our pac ate `cell` in `round`: the claim key to send, or null for a cell
   * with no pellet. `undo` is handed back if someone else wins the claim.
   */
  eat(round: number, cell: string, undo: T, now: number): string | null {
    const key = pelletClaimKey(round, cell);
    if (key !== null && !this.pending.has(key)) {
      this.pending.set(key, { cell, sentAt: now, undo });
    }
    return key;
  }

  /**
   * Settle every eat the server has answered — a key in `claims` is its word,
   * whoever holds it — and return the ones someone else won.
   */
  settle(claims: ClaimMap, me: string | null): LostEat<T>[] {
    const lost: LostEat<T>[] = [];
    for (const [key, eat] of this.pending) {
      const owner = claims[key]?.owner;
      if (owner === undefined) {
        continue;
      }
      this.pending.delete(key);
      if (owner !== me && eat.undo !== null) {
        lost.push({ cell: eat.cell, undo: eat.undo });
      }
    }
    return lost;
  }

  /** The cells gone from the maze of `round`: every claim on one, and our own eats in flight. */
  eaten(claims: ClaimMap, round: number): Set<string> {
    const cells = new Set<string>();
    for (const key of Object.keys(claims)) {
      const cell = claimedCell(key, round);
      if (cell !== null) {
        cells.add(cell);
      }
    }
    for (const eat of this.pending.values()) {
      cells.add(eat.cell);
    }
    return cells;
  }

  /**
   * Claims still unanswered `retryMs` after they were sent, marked sent again.
   * A claim written into a socket that was already dying never reaches the
   * server; asking again is harmless, since the server re-grants a key to the
   * player already holding it.
   */
  overdue(now: number, retryMs: number): string[] {
    const keys: string[] = [];
    for (const [key, eat] of this.pending) {
      if (now - eat.sentAt >= retryMs) {
        eat.sentAt = now;
        keys.push(key);
      }
    }
    return keys;
  }

  /** The score these eats went into was reset: they stay eaten, but hand nothing back. */
  forgive(): void {
    for (const eat of this.pending.values()) {
      eat.undo = null;
    }
  }

  /** A new round: nothing in flight belongs to it. */
  clear(): void {
    this.pending.clear();
  }
}
