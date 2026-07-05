// Hand-edited street-grid overrides, exported from the map editor (?editor=1).
// Cells are [gx, gz] grid coordinates. `add` turns a cell into road; `remove`
// deletes a road cell. Applied in grid.ts on top of the baked OSM mask —
// paint in the editor, Copy map JSON, paste here, reload/deploy.
export const CUSTOM_MAP: {
  add: readonly (readonly [number, number])[];
  remove: readonly (readonly [number, number])[];
  floor: readonly (readonly [number, number, FloorKind])[];
} = {
  add: [],
  remove: [],
  floor: [],
};

// Paintable ground surfaces (editor "Floor" mode).
export type FloorKind = "plaza" | "grass" | "sand";
export const FLOOR_KINDS: readonly FloorKind[] = ["plaza", "grass", "sand"];

// Browser-local (unbaked) edits live here between editor sessions.
export const MAP_OVERRIDES_KEY = "crazy-waymo:map-overrides";

export type MapOverrides = {
  add: [number, number][];
  remove: [number, number][];
  floor: [number, number, FloorKind][];
};

export function loadLocalOverrides(): MapOverrides {
  try {
    const raw = window.localStorage.getItem(MAP_OVERRIDES_KEY);
    if (!raw) return { add: [], remove: [], floor: [] };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { add: [], remove: [], floor: [] };
    const pick = (k: "add" | "remove"): [number, number][] => {
      const v = (parsed as Record<string, unknown>)[k];
      if (!Array.isArray(v)) return [];
      const out: [number, number][] = [];
      for (const c of v) {
        if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
          out.push([c[0], c[1]]);
        }
      }
      return out;
    };
    const floor: [number, number, FloorKind][] = [];
    const fv = (parsed as Record<string, unknown>)["floor"];
    if (Array.isArray(fv)) {
      for (const c of fv) {
        if (
          Array.isArray(c) &&
          typeof c[0] === "number" &&
          typeof c[1] === "number" &&
          (c[2] === "plaza" || c[2] === "grass" || c[2] === "sand")
        ) {
          floor.push([c[0], c[1], c[2]]);
        }
      }
    }
    return { add: pick("add"), remove: pick("remove"), floor };
  } catch {
    return { add: [], remove: [], floor: [] };
  }
}

export function saveLocalOverrides(o: MapOverrides): void {
  try {
    window.localStorage.setItem(MAP_OVERRIDES_KEY, JSON.stringify(o));
  } catch {
    // Sandboxed storage just loses persistence, never the editor.
  }
}
