import type { HeroName } from "../data/animations";
import type { Enemy } from "../entities/enemy";
import type { Player } from "../entities/player";
import type { CheckpointSeats } from "../net/checkpoint";
import type { NetSession } from "../net/session";
import { NEUTRAL_INPUT } from "../sys/input";
import type { InputState } from "../sys/input";

// Per-player melee/special hit-dedup so one swing hits each enemy once.
export interface CombatState {
  hitSwing: Set<Enemy>;
  lastSwing: number;
  hitSpecial: Set<Enemy>;
  lastSpecial: number;
  bossSwing: number;
  bossSpecial: number;
}
export const newCombatState = (): CombatState => ({
  bossSpecial: -1,
  bossSwing: -1,
  hitSpecial: new Set(),
  hitSwing: new Set(),
  lastSpecial: -1,
  lastSwing: -1,
});

// Versus: per-attacker swing/special dedup so one strike lands on the victim once.
export interface DuelHits {
  swing: number;
  special: number;
}

export type Authority =
  | { kind: "waiting" }
  | { kind: "ready"; runId: string; term: number; revision: number };

// Who is playing, from this client's point of view: the local body, the other
// player when connected, and the session/role/seat bookkeeping that names them.
// The local player is always `player`; combat runs per-player with its own
// hit-dedup state. Networking undefined = solo. Host runs the authoritative sim
// + broadcasts; guest renders the broadcast, predicting only its own body.
export interface SeatState {
  session: NetSession | undefined;
  role: "solo" | "host" | "guest";
  mode: "coop" | "versus";
  seats: CheckpointSeats;
  remoteId: string | null;
  authority: Authority;
  player: Player;
  remote: Player | undefined;
  heroName: HeroName;
  requestedHero: HeroName;
  combatStates: WeakMap<Player, CombatState>;
  duelHits: WeakMap<Player, DuelHits>;
  // this frame's local sample (guest)
  guestIn: InputState;
  controlsPaused: boolean;
  neutralOnAdmission: boolean;
  // host: which peer's wire input is being edge-detected, and whether it is live
  remoteInputOwner: { id: string; active: boolean } | null;
}

export const newSeatState = (
  heroName: HeroName,
  mode: SeatState["mode"],
  player: Player,
): SeatState => ({
  authority: { kind: "waiting" },
  combatStates: new WeakMap(),
  controlsPaused: false,
  duelHits: new WeakMap(),
  guestIn: NEUTRAL_INPUT,
  heroName,
  mode,
  neutralOnAdmission: false,
  player,
  remote: undefined,
  remoteId: null,
  remoteInputOwner: null,
  requestedHero: heroName,
  role: "solo",
  seats: { guest: null, host: null },
  session: undefined,
});

export const livePlayers = (seat: SeatState): Player[] =>
  seat.remote ? [seat.player, seat.remote] : [seat.player];

export const ownerId = (seat: SeatState, pl: Player): string | null =>
  pl === seat.player ? (seat.session?.playerId ?? null) : seat.remoteId;

export const seatPlayer = (seat: SeatState, id: string): Player | undefined => {
  if (id === seat.session?.playerId) {
    return seat.player;
  }
  return id === seat.remoteId ? seat.remote : undefined;
};

export const combatState = (seat: SeatState, pl: Player): CombatState => {
  let s = seat.combatStates.get(pl);
  if (!s) {
    s = newCombatState();
    seat.combatStates.set(pl, s);
  }
  return s;
};

export const duelHits = (seat: SeatState, pl: Player): DuelHits => {
  let s = seat.duelHits.get(pl);
  if (!s) {
    s = { special: 0, swing: 0 };
    seat.duelHits.set(pl, s);
  }
  return s;
};
