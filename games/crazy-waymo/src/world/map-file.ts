import type { CustomProp } from "./custom-props";
import { CUSTOM_PROPS } from "./custom-props";
import type { FloorKind } from "./custom-map";
import {
  isFiniteJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonValue,
  parseJsonText,
} from "../shared/json";

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

function floorKindOf(v: JsonValue | undefined): FloorKind | null {
  return v === "plaza" || v === "grass" || v === "sand" ? v : null;
}

function pairList(v: JsonValue | undefined): [number, number][] {
  if (!Array.isArray(v)) return [];
  const out: [number, number][] = [];
  for (const p of v) {
    if (Array.isArray(p) && isFiniteJsonNumber(p[0]) && isFiniteJsonNumber(p[1])) {
      out.push([p[0], p[1]]);
    }
  }
  return out;
}

export function parseMapFile(raw: JsonValue): MapFile | null {
  if (!isJsonObject(raw)) return null;
  if (raw.version !== 1) return null;
  const streets = isJsonObject(raw.streets) ? raw.streets : {};
  const floor: [number, number, FloorKind][] = [];
  if (Array.isArray(raw.floor)) {
    for (const f of raw.floor) {
      if (!Array.isArray(f) || !isFiniteJsonNumber(f[0]) || !isFiniteJsonNumber(f[1])) continue;
      const kind = floorKindOf(f[2]);
      if (kind !== null) floor.push([f[0], f[1], kind]);
    }
  }
  const props: CustomProp[] = [];
  if (Array.isArray(raw.props)) {
    for (const q of raw.props) {
      if (!isJsonObject(q)) continue;
      if (!isJsonString(q.model) || !isFiniteJsonNumber(q.u) || !isFiniteJsonNumber(q.v)) {
        continue;
      }
      const prop: CustomProp = {
        model: q.model,
        u: q.u,
        v: q.v,
        yaw: isFiniteJsonNumber(q.yaw) ? q.yaw : 0,
        s: isFiniteJsonNumber(q.s) ? q.s : 1,
      };
      props.push(q.solid === true ? { ...prop, solid: true } : prop);
    }
  }
  return {
    version: 1,
    streets: { add: pairList(streets.add), remove: pairList(streets.remove) },
    floor,
    props,
    clear: pairList(raw.clear),
  };
}

// --- Local prop persistence (editor sessions survive reloads) ---
const PROPS_KEY = "crazy-waymo:map-props";

export function loadLocalProps(): CustomProp[] {
  try {
    const raw = localStorage.getItem(PROPS_KEY);
    if (!raw) return [];
    const parsed = parseJsonText(raw);
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
