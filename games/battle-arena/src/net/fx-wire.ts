import { isJsonNumber, isJsonObject, isJsonString } from "../data/json";
import type { JsonValue } from "../data/json";
import { ALL_ABILITY_KEYS } from "../sim/types";
import type { FxEvent } from "../sim/types";

type FieldKind = "number" | "string" | "boolean" | "damage" | "ability";

interface FxFields {
  required: Readonly<Record<string, FieldKind>>;
  optional?: Readonly<Record<string, FieldKind>>;
}

const DAMAGE_TYPES: ReadonlySet<string> = new Set(["physical", "magic", "pure"]);
const ABILITY_KEYS: ReadonlySet<string> = new Set(ALL_ABILITY_KEYS);
const POINT = { x: "number", y: "number" } as const;

const FX_FIELDS = {
  blink: { required: { ...POINT, tx: "number", ty: "number" } },
  cast: {
    optional: { unitId: "string" },
    required: { ...POINT, champId: "string", dx: "number", dy: "number", key: "ability" },
  },
  coinGrab: { required: { ...POINT, gold: "number" } },
  coinThrow: { required: { ...POINT, tx: "number", ty: "number" } },
  death: { required: { ...POINT, by: "string", team: "string" } },
  delivery: { required: { ...POINT, playerName: "string", tier: "string" } },
  explosion: { required: { ...POINT, kind: "string", radius: "number" } },
  fizzle: { required: { ...POINT, kind: "string" } },
  heal: { required: { ...POINT, amount: "number" } },
  hit: {
    optional: { crit: "boolean" },
    required: {
      ...POINT,
      amount: "number",
      by: "string",
      dtype: "damage",
      dx: "number",
      dy: "number",
      to: "string",
    },
  },
  itemUse: { required: { ...POINT, item: "string" } },
  kill: {
    optional: { leader: "boolean" },
    required: { killer: "string", killerName: "string", victim: "string", victimName: "string" },
  },
  levelup: { required: POINT },
  notify: { required: { kind: "string", text: "string" } },
  perfectDodge: { required: { ...POINT, unit: "string" } },
  propBreak: { optional: { explosive: "boolean" }, required: { ...POINT, model: "string" } },
  strike: {
    required: { ...POINT, dx: "number", dy: "number", r: "number", tag: "string" },
  },
  swing: {
    required: { ...POINT, ang: "number", dtype: "damage", melee: "boolean", r: "number" },
  },
} satisfies Record<FxEvent["t"], FxFields>;

const FIELDS_BY_TAG = new Map<string, FxFields>(Object.entries(FX_FIELDS));

const fitsKind = (value: JsonValue | undefined, kind: FieldKind) => {
  switch (kind) {
    case "number": {
      return isJsonNumber(value);
    }

    case "string": {
      return isJsonString(value);
    }

    case "boolean": {
      return value === true || value === false;
    }

    case "damage": {
      return isJsonString(value) && DAMAGE_TYPES.has(value);
    }

    case "ability": {
      return isJsonString(value) && ABILITY_KEYS.has(value);
    }

    default: {
      const unhandled: never = kind;
      throw new Error("unhandled FX field kind", { cause: unhandled });
    }
  }
};

/** Whether a wire value is one of the host's FX events, every field of its kind. */
export const isFxEvent = (value: JsonValue): value is FxEvent => {
  if (!isJsonObject(value) || !isJsonString(value.t)) {
    return false;
  }

  const fields = FIELDS_BY_TAG.get(value.t);

  if (fields === undefined) {
    return false;
  }

  const required = Object.entries(fields.required).every(([key, kind]) =>
    fitsKind(value[key], kind),
  );

  const optional = Object.entries(fields.optional ?? {}).every(
    ([key, kind]) => value[key] === undefined || fitsKind(value[key], kind),
  );

  return required && optional;
};
