import { getRuntimeMap } from "./map-file";
import { isFiniteJsonNumber, isJsonObject, parseJsonText } from "../shared/json";

interface CustomMapEdits {
  add: readonly (readonly [number, number])[];
  remove: readonly (readonly [number, number])[];
  floor: readonly (readonly [number, number, FloorKind])[];
}

export const CUSTOM_MAP: CustomMapEdits = {
  add: [],
  floor: [],
  remove: [],
};

export type FloorKind = "plaza" | "grass" | "sand";

export const FLOOR_KINDS: readonly FloorKind[] = ["plaza", "grass", "sand"];

export const MAP_OVERRIDES_KEY = "crazy-waymo:map-overrides";

export interface MapOverrides {
  add: [number, number][];
  remove: [number, number][];
  floor: [number, number, FloorKind][];
  clear?: [number, number][];
}

export const editorMode = () => {
  try {
    return new URLSearchParams(window.location.search).has("editor");
  } catch {
    return false;
  }
};

export const loadLocalOverrides = () => {
  const rt = getRuntimeMap();

  if (rt) {
    return {
      add: rt.streets.add,
      clear: rt.clear ?? [],
      floor: rt.floor,
      remove: rt.streets.remove,
    };
  }

  if (!editorMode()) {
    return { add: [], floor: [], remove: [] };
  }

  try {
    const raw = window.localStorage.getItem(MAP_OVERRIDES_KEY);

    if (!raw) {
      return { add: [], floor: [], remove: [] };
    }

    const parsed = parseJsonText(raw);

    if (!isJsonObject(parsed)) {
      return { add: [], floor: [], remove: [] };
    }

    const pick = (k: "add" | "remove") => {
      const v = parsed[k];

      if (!Array.isArray(v)) {
        return [];
      }

      const out: [number, number][] = [];

      for (const c of v) {
        if (Array.isArray(c) && isFiniteJsonNumber(c[0]) && isFiniteJsonNumber(c[1])) {
          out.push([c[0], c[1]]);
        }
      }

      return out;
    };

    const floor: [number, number, FloorKind][] = [];
    const fv = parsed["floor"];

    if (Array.isArray(fv)) {
      for (const c of fv) {
        if (
          Array.isArray(c) &&
          isFiniteJsonNumber(c[0]) &&
          isFiniteJsonNumber(c[1]) &&
          (c[2] === "plaza" || c[2] === "grass" || c[2] === "sand")
        ) {
          floor.push([c[0], c[1], c[2]]);
        }
      }
    }

    return { add: pick("add"), floor, remove: pick("remove") };
  } catch {
    return { add: [], floor: [], remove: [] };
  }
};

export const saveLocalOverrides = (o: MapOverrides) => {
  try {
    window.localStorage.setItem(MAP_OVERRIDES_KEY, JSON.stringify(o));
  } catch {}
};
