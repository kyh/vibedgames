import { isJsonNumber, isJsonObject } from "../json";
import type { World } from "../world/world";
import type { Inventory } from "./inventory";
import type { JsonValue } from "../json";
import type { SkillsJSON } from "./skills";

const KEY = "farm-rpg-save-v1";

// Per-system save fragments are optional so older saves keep loading as systems
// are added. Concrete shapes are owned by their modules.
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
}

// Trailer mode (src/trailer/): a staged demo run must neither read nor write
// the player's real save. Set once by the trailer director; dead in normal play.
let savesDisabled = false;
export const disableSaves = (): void => {
  savesDisabled = true;
};

// Structural check at the storage boundary: we only wrote v3 saves ourselves,
// so verify the version tag plus the scalar/object skeleton (not every leaf).
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

export const hasSave = (): boolean => {
  if (savesDisabled) {
    return false;
  }
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
};

export const loadSave = (): SaveData | null => {
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

export const writeSave = (d: SaveData): void => {
  if (savesDisabled) {
    return;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* storage full / unavailable — ignore */
  }
};

// Merge a partial update into the existing save (used by the mine to persist
// inventory/skills/gold/hp progress without owning the farm world).
export const patchSave = (patch: Partial<SaveData>): void => {
  const cur = loadSave();
  if (!cur) {
    return;
  }
  writeSave({ ...cur, ...patch });
};

export const clearSave = (): void => {
  if (savesDisabled) {
    return;
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
};
