import { isJsonNumber, isJsonObject } from "../json";
import type { World } from "../world/world";
import type { Inventory } from "./inventory";
import type { JsonValue } from "../json";
import type { SkillsJSON } from "./skills";
import type { CollectionsJSON } from "./collections";

const KEY = "farm-rpg-save-v1";

export interface AnimalSave {
  id: number;
  kind: string;
  building: "barn" | "coop";
  name: string;
  friendship: number;
  fed: boolean;
  producedToday: boolean;
  x: number;
  y: number;
}

export interface SaveData {
  v: 3;
  seed: number;
  day: number;
  timeMin: number;
  gold: number;
  energy: number;
  hp: number;
  canCharge: number;
  player: { x: number; y: number };
  world: ReturnType<World["toJSON"]>;
  inv: ReturnType<Inventory["toJSON"]>;
  skills: SkillsJSON;
  animals?: AnimalSave[];
  animalSeq?: number;
  npcFriendship?: Record<string, number>;
  collections?: CollectionsJSON;
}

/** "failure" = storage threw (full/blocked); the caller keeps the save dirty and retries. */
export type SaveOutcome = { kind: "success" } | { kind: "disabled" } | { kind: "failure" };

let savesDisabled = false;

export const disableSaves = () => {
  savesDisabled = true;
};

const isSaveData = (v: JsonValue): v is JsonValue & SaveData => {
  if (!isJsonObject(v) || v["v"] !== 3) {
    return false;
  }

  const nums = ["seed", "day", "timeMin", "gold", "energy", "hp", "canCharge"];

  if (!nums.every((k) => isJsonNumber(v[k]))) {
    return false;
  }

  return (
    isJsonObject(v["player"]) &&
    isJsonObject(v["world"]) &&
    isJsonObject(v["inv"]) &&
    isJsonObject(v["skills"])
  );
};

export const loadSave = () => {
  if (savesDisabled) {
    return null;
  }

  try {
    const raw = localStorage.getItem(KEY);

    if (!raw) {
      return null;
    }

    const d: JsonValue = JSON.parse(raw);

    return isSaveData(d) ? d : null;
  } catch {
    return null;
  }
};

export const writeSave: (d: SaveData) => SaveOutcome = (d) => {
  if (savesDisabled) {
    return { kind: "disabled" };
  }

  try {
    localStorage.setItem(KEY, JSON.stringify(d));

    return { kind: "success" };
  } catch {
    return { kind: "failure" };
  }
};

export const clearSave = () => {
  if (savesDisabled) {
    return;
  }

  try {
    localStorage.removeItem(KEY);
  } catch {}
};
