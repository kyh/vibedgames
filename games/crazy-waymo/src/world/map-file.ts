import type { CustomProp } from "./custom-props";
import { CUSTOM_PROPS } from "./custom-props";
import type { FloorKind } from "./custom-map";

// One-file map format (battle-arena style): streets + floors + props in a
// single versioned JSON. The editor SAVEs it as a download; the game builds
// a world from one via `?map=<url>` (or the editor LOADs it back).

export type MapFile = {
  version: 1;
  streets: { add: [number, number][]; remove: [number, number][] };
  floor: [number, number, FloorKind][];
  props: CustomProp[];
  clear?: [number, number][];
};

let runtimeMap: MapFile | null = null;

export function setRuntimeMap(m: MapFile): void {
  runtimeMap = m;
}

export function getRuntimeMap(): MapFile | null {
  return runtimeMap;
}

const FLOOR_KINDS = new Set(["plaza", "grass", "sand"]);

function pairList(v: unknown): [number, number][] {
  if (!Array.isArray(v)) return [];
  const out: [number, number][] = [];
  for (const p of v) {
    if (Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number") {
      out.push([p[0], p[1]]);
    }
  }
  return out;
}

export function parseMapFile(raw: unknown): MapFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return null;
  const streets = (o.streets ?? {}) as Record<string, unknown>;
  const floor: [number, number, FloorKind][] = [];
  if (Array.isArray(o.floor)) {
    for (const f of o.floor) {
      if (
        Array.isArray(f) &&
        typeof f[0] === "number" &&
        typeof f[1] === "number" &&
        typeof f[2] === "string" &&
        FLOOR_KINDS.has(f[2])
      ) {
        floor.push([f[0], f[1], f[2] as FloorKind]);
      }
    }
  }
  const props: CustomProp[] = [];
  if (Array.isArray(o.props)) {
    for (const p of o.props) {
      if (typeof p !== "object" || p === null) continue;
      const q = p as Record<string, unknown>;
      if (typeof q.model !== "string" || typeof q.u !== "number" || typeof q.v !== "number") {
        continue;
      }
      props.push({
        model: q.model,
        u: q.u,
        v: q.v,
        yaw: typeof q.yaw === "number" ? q.yaw : 0,
        s: typeof q.s === "number" ? q.s : 1,
        ...(q.solid === true ? { solid: true } : {}),
      });
    }
  }
  return {
    version: 1,
    streets: { add: pairList(streets.add), remove: pairList(streets.remove) },
    floor,
    props,
    clear: pairList(o.clear),
  };
}

// --- Local prop persistence (editor sessions survive reloads) ---
const PROPS_KEY = "crazy-waymo:map-props";

export function loadLocalProps(): CustomProp[] {
  try {
    const raw = localStorage.getItem(PROPS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const m = parseMapFile({ version: 1, streets: {}, floor: [], props: parsed });
    return m ? m.props : [];
  } catch {
    return [];
  }
}

export function saveLocalProps(props: readonly CustomProp[]): void {
  try {
    localStorage.setItem(PROPS_KEY, JSON.stringify(props));
  } catch {
    // storage full/blocked — editor keeps working, props just don't persist
  }
}

// What the city build actually places: a runtime map file replaces everything;
// otherwise baked props (+ this browser's editor props, editor mode only).
export function activeMapProps(editor: boolean): readonly CustomProp[] {
  if (runtimeMap) return runtimeMap.props;
  return editor ? [...CUSTOM_PROPS, ...loadLocalProps()] : CUSTOM_PROPS;
}
