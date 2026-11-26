import type { CustomProp } from "./custom-props";
import { CUSTOM_PROPS } from "./custom-props";
import type { FloorKind } from "./custom-map";
import { isFiniteJsonNumber, isJsonObject, isJsonString, parseJsonText } from "../shared/json";
import type { JsonValue } from "../shared/json";

export interface MapFile {
  version: 1;
  streets: { add: [number, number][]; remove: [number, number][] };
  floor: [number, number, FloorKind][];
  props: CustomProp[];
  clear?: [number, number][];
}

let runtimeMap: MapFile | null = null;

export const setRuntimeMap = (m: MapFile) => {
  runtimeMap = m;
};

export const getRuntimeMap = () => runtimeMap;

const floorKindOf = (v: JsonValue | undefined) =>
  v === "plaza" || v === "grass" || v === "sand" ? v : null;

const pairList = (v: JsonValue | undefined) => {
  if (!Array.isArray(v)) {
    return [];
  }

  const out: [number, number][] = [];

  for (const p of v) {
    if (Array.isArray(p) && isFiniteJsonNumber(p[0]) && isFiniteJsonNumber(p[1])) {
      out.push([p[0], p[1]]);
    }
  }

  return out;
};

export const parseMapFile: (raw: JsonValue) => MapFile | null = (raw) => {
  if (!isJsonObject(raw)) {
    return null;
  }

  if (raw.version !== 1) {
    return null;
  }

  const streets = isJsonObject(raw.streets) ? raw.streets : {};
  const floor: [number, number, FloorKind][] = [];

  if (Array.isArray(raw.floor)) {
    for (const f of raw.floor) {
      if (!Array.isArray(f) || !isFiniteJsonNumber(f[0]) || !isFiniteJsonNumber(f[1])) {
        continue;
      }

      const kind = floorKindOf(f[2]);

      if (kind !== null) {
        floor.push([f[0], f[1], kind]);
      }
    }
  }

  const props: CustomProp[] = [];

  if (Array.isArray(raw.props)) {
    for (const q of raw.props) {
      if (!isJsonObject(q)) {
        continue;
      }

      if (!isJsonString(q.model) || !isFiniteJsonNumber(q.u) || !isFiniteJsonNumber(q.v)) {
        continue;
      }

      const prop: CustomProp = {
        model: q.model,
        s: isFiniteJsonNumber(q.s) ? q.s : 1,
        u: q.u,
        v: q.v,
        yaw: isFiniteJsonNumber(q.yaw) ? q.yaw : 0,
      };

      props.push(q.solid === true ? { ...prop, solid: true } : prop);
    }
  }

  return {
    clear: pairList(raw.clear),
    floor,
    props,
    streets: { add: pairList(streets.add), remove: pairList(streets.remove) },
    version: 1,
  };
};

const PROPS_KEY = "crazy-waymo:map-props";

export const loadLocalProps = () => {
  try {
    const raw = localStorage.getItem(PROPS_KEY);

    if (raw === null || raw === "") {
      return [];
    }

    const parsed = parseJsonText(raw);
    const m = parseMapFile({ floor: [], props: parsed, streets: {}, version: 1 });

    return m ? m.props : [];
  } catch {
    return [];
  }
};

export const saveLocalProps = (props: readonly CustomProp[]) => {
  try {
    localStorage.setItem(PROPS_KEY, JSON.stringify(props));

    return true;
  } catch {
    return false;
  }
};

export const activeMapProps = (editor: boolean) => {
  if (runtimeMap) {
    return runtimeMap.props;
  }

  return editor ? [...CUSTOM_PROPS, ...loadLocalProps()] : CUSTOM_PROPS;
};
