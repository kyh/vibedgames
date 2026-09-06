import { isJsonNumber, isJsonObject } from "../json";
import { World } from "../world/world";
import { Inventory } from "./inventory";
import type { JsonValue } from "../json";
import type { SkillsJSON } from "./skills";
import { Collections, type CollectionsJSON } from "./collections";

const KEY = "farm-rpg-save-v1";

// Per-system save fragments are optional so older saves keep loading as systems
// are added. Concrete shapes are owned by their modules.
export type AnimalSave = {
  id: number;
  kind: string;
  building: "barn" | "coop";
  name: string;
  friendship: number;
  fed: boolean;
  producedToday: boolean;
  x: number;
  y: number;
};

export type SaveData = {
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
};

export type SaveOutcome =
  | { kind: "success" }
  | { kind: "disabled" }
  | { kind: "failure"; reason: "storage" | "missing" | "invalid" };

type SaveRead =
  | { kind: "ready"; data: SaveData }
  | { kind: "missing" | "invalid" | "storage" | "disabled" };

// Trailer mode (src/trailer/): a staged demo run must neither read nor write
// the player's real save. Set once by the trailer director; dead in normal play.
let savesDisabled = false;
export function disableSaves(): void {
  savesDisabled = true;
}

// Structural check at the storage boundary: we only wrote v3 saves ourselves,
// so verify the version tag plus the scalar/object skeleton (not every leaf).
function isSaveData(v: JsonValue): v is JsonValue & SaveData {
  if (!isJsonObject(v) || v["v"] !== 3) return false;
  const nums = ["seed", "day", "timeMin", "gold", "energy", "hp", "canCharge"];
  if (!nums.every((k) => isJsonNumber(v[k]))) return false;
  return (
    isJsonObject(v["player"]) &&
    isJsonObject(v["world"]) &&
    isJsonObject(v["inv"]) &&
    isJsonObject(v["skills"])
  );
}

export function hasSave(): boolean {
  if (savesDisabled) return false;
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function loadSave(): SaveData | null {
  const read = readSave();
  return read.kind === "ready" ? read.data : null;
}

function readSave(): SaveRead {
  if (savesDisabled) return { kind: "disabled" };
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return { kind: "storage" };
  }
  if (raw === null) return { kind: "missing" };
  try {
    const d: JsonValue = JSON.parse(raw);
    if (!isSaveData(d)) return { kind: "invalid" };
    const data: SaveData = d;
    return {
      kind: "ready",
      data: { ...data, collections: Collections.fromJSON(data.collections).toJSON() },
    };
  } catch {
    return { kind: "invalid" };
  }
}

export function writeSave(d: SaveData): SaveOutcome {
  if (savesDisabled) return { kind: "disabled" };
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
    return { kind: "success" };
  } catch {
    return { kind: "failure", reason: "storage" };
  }
}

// Merge a partial update into the existing save (used by the mine to persist
// inventory/skills/gold/hp progress without owning the farm world).
export function patchSave(patch: Partial<SaveData>): SaveOutcome {
  const read = readSave();
  if (read.kind === "disabled") return { kind: "disabled" };
  if (read.kind !== "ready") return { kind: "failure", reason: read.kind };
  return writeSave({ ...read.data, ...patch });
}

export function clearSave(): SaveOutcome {
  if (savesDisabled) return { kind: "disabled" };
  try {
    localStorage.removeItem(KEY);
    return { kind: "success" };
  } catch {
    return { kind: "failure", reason: "storage" };
  }
}
