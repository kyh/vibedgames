import type { HeroName } from "../data/animations";
import type { Enemy } from "../entities/enemy";
import type { Player } from "../entities/player";
import type { CheckpointSeats } from "../net/checkpoint";
import type { NetSession } from "../net/session";
import { NEUTRAL_INPUT } from "../sys/input";
import type { InputState } from "../sys/input";

export interface CombatState {
  hitSwing: Set<Enemy>;
  lastSwing: number;
  hitSpecial: Set<Enemy>;
  lastSpecial: number;
  bossSwing: number;
  bossSpecial: number;
}

export const newCombatState: () => CombatState = () => ({
  bossSpecial: -1,
  bossSwing: -1,
  hitSpecial: new Set(),
  hitSwing: new Set(),
  lastSpecial: -1,
  lastSwing: -1,
});

export interface DuelHits {
  swing: number;
  special: number;
}

export type Authority =
  | { kind: "waiting" }
  | { kind: "ready"; runId: string; term: number; revision: number };

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
  guestIn: InputState;
  controlsPaused: boolean;
  neutralOnAdmission: boolean;
}

export const newSeatState: (
  heroName: HeroName,
  mode: SeatState["mode"],
  player: Player,
) => SeatState = (heroName, mode, player) => ({
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
  requestedHero: heroName,
  role: "solo",
  seats: { guest: null, host: null },
  session: undefined,
});

export const livePlayers = (seat: SeatState) =>
  seat.remote ? [seat.player, seat.remote] : [seat.player];

/** The host advances a guest's body once per input tick the guest sent
 * (scenes/host-net.ts), not once per host step — every other body steps here. */
export const inputDriven = (seat: SeatState, pl: Player) =>
  seat.role === "host" && pl === seat.remote;

export const ownerId = (seat: SeatState, pl: Player) =>
  pl === seat.player ? (seat.session?.playerId ?? null) : seat.remoteId;

export const seatPlayer = (seat: SeatState, id: string) => {
  if (id === seat.session?.playerId) {
    return seat.player;
  }

  return id === seat.remoteId ? seat.remote : undefined;
};

export const combatState: (seat: SeatState, pl: Player) => CombatState = (seat, pl) => {
  let s = seat.combatStates.get(pl);

  if (!s) {
    s = newCombatState();
    seat.combatStates.set(pl, s);
  }

  return s;
};

export const duelHits = (seat: SeatState, pl: Player) => {
  let s = seat.duelHits.get(pl);

  if (!s) {
    s = { special: 0, swing: 0 };
    seat.duelHits.set(pl, s);
  }

  return s;
};
