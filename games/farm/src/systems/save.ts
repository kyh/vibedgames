import { World } from "../world/world";
import { Inventory } from "./inventory";
import type { SkillsJSON } from "./skills";

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
};

export function hasSave(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SaveData;
    if (d.v !== 3) return null;
    return d;
  } catch {
    return null;
  }
}

export function writeSave(d: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* storage full / unavailable — ignore */
  }
}

// Merge a partial update into the existing save (used by the mine to persist
// inventory/skills/gold/hp progress without owning the farm world).
export function patchSave(patch: Partial<SaveData>): void {
  const cur = loadSave();
  if (!cur) return;
  writeSave({ ...cur, ...patch });
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
