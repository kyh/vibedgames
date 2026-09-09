import { loadMeta, runBonuses } from "../data/meta";
import { baseMods } from "../data/relics";
import type { RunMods } from "../data/relics";
import type { RunRecap } from "../data/run-recap";
import type { Player } from "../entities/player";
import type { NetLastStand, NetVersus } from "../net/snapshot";
import type { Offer } from "../sys/run";
import type { VersusMatch } from "../sys/versus";

export type SceneState = "active" | "dead" | "transition" | "connecting";

// Host-simulated co-op last stand: the downed player, its bleed-out clock and
// the rescuer's revive-hold progress.
export interface LastStandLive {
  pl: Player;
  bleedT: number;
  reviveT: number;
}

// One expedition's economy, clocks and phase — shared by the scene and every
// collaborator, mutated in place. Reset wholesale with `newRunState()`.
export interface RunState {
  state: SceneState;
  hearts: number;
  maxHearts: number;
  gold: number;
  score: number;
  // consecutive-kill streak within the combo window
  combo: number;
  // seconds left before the streak lapses
  comboT: number;
  // hitstop seconds left
  freeze: number;
  // fixed-step accumulator
  acc: number;
  mods: RunMods;
  ownedRelics: Set<string>;
  offers: Offer[];
  pendingOffer: Offer | null;
  mustClear: boolean;
  cleared: boolean;
  bossDeadT: number;
  deadT: number;
  transT: number;
  transBuilt: boolean;
  runRecap: RunRecap | null;
  // last biome announced, so a descent flashes the new name
  flashedBiome: number;
  // co-op last stand: host-simulated, and the guest's mirror of the broadcast
  downed: LastStandLive | null;
  downedNet: NetLastStand | null;
  // versus: host-authoritative match, and the guest's mirror of the broadcast
  match: VersusMatch | null;
  matchNet: NetVersus | null;
  // host snapshot counter
  tick: number;
}

// Base mods plus the permanent meta upgrades bought in the hub (host/solo; a
// guest's hearts are then overwritten by the host snapshot).
export const metaMods = (): RunMods => {
  const mods = baseMods();
  const bonus = runBonuses(loadMeta());
  mods.dmg += bonus.dmg;
  mods.armor += bonus.armor;
  mods.maxHearts += bonus.hearts;
  return mods;
};

export const newRunState = (mods = metaMods()): RunState => ({
  acc: 0,
  bossDeadT: 0,
  cleared: false,
  combo: 0,
  comboT: 0,
  deadT: 0,
  downed: null,
  downedNet: null,
  flashedBiome: 0,
  freeze: 0,
  gold: 0,
  hearts: mods.maxHearts,
  match: null,
  matchNet: null,
  maxHearts: mods.maxHearts,
  mods,
  mustClear: false,
  offers: [],
  ownedRelics: new Set(),
  pendingOffer: null,
  runRecap: null,
  score: 0,
  state: "active",
  tick: 0,
  transBuilt: false,
  transT: 0,
});
