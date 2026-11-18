import { loadMeta, runBonuses } from "../data/meta";
import { baseMods } from "../data/relics";
import type { RunMods } from "../data/relics";
import type { RunRecap } from "../data/run-recap";
import type { Player } from "../entities/player";
import type { NetLastStand, NetVersus } from "../net/snapshot";
import type { Offer } from "../sys/run";
import type { VersusMatch } from "../sys/versus";

export type SceneState = "active" | "dead" | "transition" | "connecting";

export interface LastStandLive {
  pl: Player;
  bleedT: number;
  reviveT: number;
}

export interface RunState {
  state: SceneState;
  hearts: number;
  maxHearts: number;
  gold: number;
  score: number;
  combo: number;
  comboT: number;
  freeze: number;
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
  flashedBiome: number;
  downed: LastStandLive | null;
  downedNet: NetLastStand | null;
  match: VersusMatch | null;
  matchNet: NetVersus | null;
}

export const metaMods = () => {
  const mods = baseMods();
  const bonus = runBonuses(loadMeta());
  mods.dmg += bonus.dmg;
  mods.armor += bonus.armor;
  mods.maxHearts += bonus.hearts;

  return mods;
};

export const newRunState = (mods = metaMods()) =>
  ({
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
    transBuilt: false,
    transT: 0,
  }) satisfies RunState;
