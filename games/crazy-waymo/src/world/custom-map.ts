import { getRuntimeMap } from "./map-file";
import { isFiniteJsonNumber, isJsonObject, parseJsonText } from "../shared/json";

// Hand-edited street-grid overrides, exported from the map editor (?editor=1).
// Cells are [gx, gz] grid coordinates. `add` turns a cell into road; `remove`
// deletes a road cell. Applied in grid.ts on top of the baked OSM mask —
// paint in the editor, Copy map JSON, paste here, reload/deploy.
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

// Paintable ground surfaces (editor "Floor" mode).
export type FloorKind = "plaza" | "grass" | "sand";
export const FLOOR_KINDS: readonly FloorKind[] = ["plaza", "grass", "sand"];

// Browser-local (unbaked) edits live here between editor sessions.
export const MAP_OVERRIDES_KEY = "crazy-waymo:map-overrides";

export interface MapOverrides {
  add: [number, number][];
  remove: [number, number][];
  floor: [number, number, FloorKind][];
  // Cells where GENERATED content (buildings, props, park tiles) is
  // suppressed — the editor's "clear" brush. Applied on rebuild.
  clear?: [number, number][];
}

// Local (per-browser) edits ONLY apply inside the editor. Normal play must
// run the canonical baked map — multiplayer shares one deterministic city,
// and a locally forked map would desync it. Ship edits to everyone by
// pasting Copy-map-JSON into CUSTOM_MAP above.
export const editorMode = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).has("editor");
  } catch {
    return false;
  }
};

export const loadLocalOverrides = (): MapOverrides => {
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
    const pick = (k: "add" | "remove"): [number, number][] => {
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

export const saveLocalOverrides = (o: MapOverrides): void => {
  try {
    window.localStorage.setItem(MAP_OVERRIDES_KEY, JSON.stringify(o));
  } catch {
    // Sandboxed storage just loses persistence, never the editor.
  }
};
