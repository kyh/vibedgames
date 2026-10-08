// Power-ups, first come first served.
//
// Two fighters stepping onto one power-up is a race. Left to the host it costs
// a guest a round trip and hands the host every tie, since the host sees its
// own body at once. Instead the fighter that steps onto a power-up claims it
// from the party server, which decides in one hop. The claimer applies the
// pickup at once (the sprite goes, the cue plays, its stats rise) and takes it
// back if the server names someone else. The host grants whatever the claim
// map shows an owner for, the same for every claimant: its own body claims
// like anyone's, and it claims for its bots.
//
// A crate breaks once, so a tile drops at most one power-up a round: the tile
// and the round name it.

import { baseStats, tileKey } from "../shared/constants";
import type { PlayerStats, Powerup, SharedState } from "../shared/constants";
import { grantPowerup } from "../sim/host-sim";

/** Every pickup claim's key starts with this; the host clears them on a new round. */
export const PICKUP_CLAIMS = "pickup:";

export const pickupKey = (round: number, pickup: Pick<Powerup, "col" | "row">): string =>
  `${PICKUP_CLAIMS}${pickup.col},${pickup.row}:${round}`;

/** The claims a room arbitrates: the `MultiplayerClient`, or `localClaims` offline. */
export interface ClaimRoom {
  claim: (key: string) => void;
  clearClaims: (prefix: string) => void;
  ownerOf: (key: string) => string | null;
}

/** First come, first served on this machine: the room's claims, offline, where `me` is the only claimant. */
export const localClaims = (me: string): ClaimRoom => {
  const owners = new Map<string, string>();
  return {
    claim: (key) => {
      if (!owners.has(key)) {
        owners.set(key, me);
      }
    },
    clearClaims: (prefix) => {
      for (const key of owners.keys()) {
        if (key.startsWith(prefix)) {
          owners.delete(key);
        }
      }
    },
    ownerOf: (key) => owners.get(key) ?? null,
  };
};

/** A claim this client made: for its own body or, as host, for a bot. */
export interface PickupClaim {
  fighter: string;
  pickup: Powerup;
  round: number;
}

/** Not settled yet: the same round, and the power-up is still on the board. */
const unsettled = (claim: PickupClaim, state: SharedState): boolean =>
  claim.round === state.startedAt &&
  state.powerups[tileKey(claim.pickup.col, claim.pickup.row)] !== undefined;

export class PickupClaims {
  private readonly claims = new Map<string, PickupClaim>();

  /**
   * Claim the power-up on `fighter`'s tile, unless someone holds it or this
   * client already asked. Returns it when this call claimed it, so a player's
   * own client can cue it at once.
   */
  reach(
    room: ClaimRoom,
    state: SharedState,
    fighter: string,
    tile: { col: number; row: number },
  ): Powerup | null {
    const pickup = state.powerups[tileKey(tile.col, tile.row)];
    if (!pickup) {
      return null;
    }
    const key = pickupKey(state.startedAt, pickup);
    if (this.claims.has(key) || room.ownerOf(key) !== null) {
      return null;
    }
    this.claims.set(key, { fighter, pickup, round: state.startedAt });
    room.claim(key);
    return pickup;
  }

  /**
   * The room named `owner` for `key`: a grant, a release, or the answer to a
   * refused claim. Returns this client's claim on it when that claim is lost
   * (someone else holds the key, or nobody does), to be taken back.
   */
  heard(key: string, owner: string | null, me: string): PickupClaim | null {
    const claim = this.claims.get(key);
    if (!claim || owner === me) {
      return null;
    }
    this.claims.delete(key);
    return claim;
  }

  /** The fighter this client claimed `key` for, or null. */
  fighterOf(key: string): string | null {
    return this.claims.get(key)?.fighter ?? null;
  }

  /** Forget claims the host has settled, or a blast or a new round overtook. */
  prune(state: SharedState | null): void {
    for (const [key, claim] of this.claims) {
      if (!state || !unsettled(claim, state)) {
        this.claims.delete(key);
      }
    }
  }

  /** `fighter`'s stats, with the claims it made that the host has yet to settle. */
  stats(state: SharedState, fighter: string): PlayerStats {
    let stats = state.stats[fighter] ?? baseStats();
    for (const claim of this.claims.values()) {
      if (claim.fighter === fighter && unsettled(claim, state)) {
        stats = grantPowerup(stats, claim.pickup.kind);
      }
    }
    return stats;
  }

  /** The power-ups still up for grabs: nobody holds them, and this client has not claimed them. */
  visible(room: ClaimRoom, state: SharedState): Record<string, Powerup> {
    const entries = Object.entries(state.powerups);
    const free = entries.filter(([, pickup]) => {
      const key = pickupKey(state.startedAt, pickup);
      return !this.claims.has(key) && room.ownerOf(key) === null;
    });
    return free.length === entries.length ? state.powerups : Object.fromEntries(free);
  }

  /**
   * Host: grant every power-up on the board whose claim has an owner (to the
   * bot this client claimed it for, or else to the owner) and take it off the
   * board. Null when nothing was granted.
   */
  settle(
    room: ClaimRoom,
    state: SharedState,
    me: string,
  ): Pick<SharedState, "powerups" | "stats"> | null {
    let stats: Record<string, PlayerStats> | null = null;
    const left: [string, Powerup][] = [];
    for (const [tile, pickup] of Object.entries(state.powerups)) {
      const key = pickupKey(state.startedAt, pickup);
      const owner = room.ownerOf(key);
      if (owner === null) {
        left.push([tile, pickup]);
        continue;
      }
      const fighter = owner === me ? (this.claims.get(key)?.fighter ?? me) : owner;
      stats ??= { ...state.stats };
      stats[fighter] = grantPowerup(stats[fighter] ?? baseStats(), pickup.kind);
    }
    return stats ? { powerups: Object.fromEntries(left), stats } : null;
  }

  clear(): void {
    this.claims.clear();
  }
}
