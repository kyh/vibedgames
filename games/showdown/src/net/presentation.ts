// The FX replay bus. The host's sim drives every visual and sound through a
// handful of choke points (Effects, GameAudio.play, Hud.floatText, the kill
// feed); each of those records a compact JSON row here while hosting, the
// rows ride alongside the snapshot, and a guest replays them by calling the
// very same methods. Sounds and effects that a guest derives locally from its
// own puppets (bullet trails, footfalls, bomb sparks, UI stingers) are never
// recorded, so nothing plays twice.
import * as THREE from "three";
import type { SoundName } from "../audio-recipes";
import type { Effects } from "../fx/effects";
import type { Hud } from "../hud";
import type { JsonObject, JsonValue } from "./json";
import { isJsonNumber as isNum, isJsonObject as isObj, isJsonString as isStr } from "./json";

/** Effects methods that replay on guests, keyed by name. */
export type FxMethod =
  | "flash"
  | "impact"
  | "burst"
  | "muzzle"
  | "dust"
  | "leaves"
  | "healPuff"
  | "debris"
  | "ring"
  | "decal"
  | "explosion"
  | "slam"
  | "defeat";

export type FxRecord =
  | { k: "fx"; m: FxMethod; a: number[] }
  | { k: "sfx"; n: SoundName; x: number | null; z: number | null }
  | { k: "float"; x: number; y: number; z: number; text: string; cls: string }
  | { k: "feed"; killer: string | null; victim: string; kid: string | null; vid: string };

export type FxRecorder = (m: FxMethod, a: number[]) => void;
export type SfxRecorder = (n: SoundName, x: number | null, z: number | null) => void;
export type FloatRecorder = (x: number, y: number, z: number, text: string, cls: string) => void;
export type FeedRecorder = (
  killer: string | null,
  victim: string,
  kid: string | null,
  vid: string,
) => void;

/** Sounds every client produces from its own state (UI stingers, own-seat cues). */
const LOCAL_SOUNDS: ReadonlySet<SoundName> = new Set<SoundName>([
  "click",
  "count",
  "gas",
  "go",
  "lose",
  "ready",
  "win",
]);

export const isLocalSound = (name: SoundName): boolean => LOCAL_SOUNDS.has(name);

const FX_METHODS: ReadonlySet<string> = new Set<FxMethod>([
  "flash",
  "impact",
  "burst",
  "muzzle",
  "dust",
  "leaves",
  "healPuff",
  "debris",
  "ring",
  "decal",
  "explosion",
  "slam",
  "defeat",
]);

const isFxMethod = (v: JsonValue | undefined): v is FxMethod => isStr(v) && FX_METHODS.has(v);

const isFxRow = (v: JsonObject): boolean =>
  isFxMethod(v["m"]) && Array.isArray(v["a"]) && v["a"].every((n) => isNum(n));

const isSfxRow = (v: JsonObject): boolean =>
  isStr(v["n"]) && (v["x"] === null || isNum(v["x"])) && (v["z"] === null || isNum(v["z"]));

const isFloatRow = (v: JsonObject): boolean =>
  isNum(v["x"]) && isNum(v["y"]) && isNum(v["z"]) && isStr(v["text"]) && isStr(v["cls"]);

const isFeedRow = (v: JsonObject): boolean =>
  (v["killer"] === null || isStr(v["killer"])) &&
  isStr(v["victim"]) &&
  (v["kid"] === null || isStr(v["kid"])) &&
  isStr(v["vid"]);

const rowGuard = (kind: JsonValue | undefined): ((v: JsonObject) => boolean) | null => {
  switch (kind) {
    case "fx": {
      return isFxRow;
    }
    case "sfx": {
      return isSfxRow;
    }
    case "float": {
      return isFloatRow;
    }
    case "feed": {
      return isFeedRow;
    }
    default: {
      return null;
    }
  }
};

const isFxRecord = (v: JsonValue): v is FxRecord => {
  if (!isObj(v)) {
    return false;
  }
  const guard = rowGuard(v["k"]);
  return guard !== null && guard(v);
};

/** The host's fx batch, validated row by row; malformed rows are dropped. */
export const parseFxBatch = (v: JsonValue | undefined): FxRecord[] =>
  Array.isArray(v) ? v.filter((row) => isFxRecord(row)) : [];

const COLOR = new THREE.Color();
const arg = (a: readonly number[], i: number): number => a[i] ?? 0;
const color = (a: readonly number[], i: number): THREE.Color => COLOR.setHex(arg(a, i));

/** Replay one recorded Effects call. */
export const replayFx = (effects: Effects, m: FxMethod, a: readonly number[]): void => {
  switch (m) {
    case "flash": {
      effects.flash(arg(a, 0), arg(a, 1), arg(a, 2), color(a, 3), arg(a, 4), arg(a, 5), arg(a, 6));
      break;
    }
    case "impact": {
      effects.impact(arg(a, 0), arg(a, 1), arg(a, 2), color(a, 3), arg(a, 4));
      break;
    }
    case "burst": {
      effects.burst(arg(a, 0), arg(a, 1), arg(a, 2), color(a, 3), arg(a, 4), arg(a, 5));
      break;
    }
    case "muzzle": {
      effects.muzzle(arg(a, 0), arg(a, 1), arg(a, 2), arg(a, 3), arg(a, 4), color(a, 5), arg(a, 6));
      break;
    }
    case "dust": {
      effects.dust(arg(a, 0), arg(a, 1), arg(a, 2), arg(a, 3));
      break;
    }
    case "leaves": {
      effects.leaves(arg(a, 0), arg(a, 1), arg(a, 2));
      break;
    }
    case "healPuff": {
      effects.healPuff(arg(a, 0), arg(a, 1));
      break;
    }
    case "debris": {
      effects.debris(arg(a, 0), arg(a, 1), arg(a, 2), arg(a, 3), arg(a, 4));
      break;
    }
    case "ring": {
      effects.ring(arg(a, 0), arg(a, 1), arg(a, 2), color(a, 3), arg(a, 4), arg(a, 5));
      break;
    }
    case "decal": {
      effects.decal(arg(a, 0), arg(a, 1), arg(a, 2));
      break;
    }
    case "explosion": {
      effects.explosion(arg(a, 0), arg(a, 1), arg(a, 2), color(a, 3), arg(a, 4) > 0.5);
      break;
    }
    case "slam": {
      effects.slam(arg(a, 0), arg(a, 1), arg(a, 2), color(a, 3));
      break;
    }
    case "defeat": {
      effects.defeat(arg(a, 0), arg(a, 1), color(a, 2));
      break;
    }
    default: {
      break;
    }
  }
};

/** Replay a batch on a guest. `localSeat` highlights the guest's own name in the feed. */
export const replayBatch = (
  effects: Effects,
  hud: Hud,
  rows: readonly FxRecord[],
  localSeat: string | null,
): void => {
  for (const row of rows) {
    switch (row.k) {
      case "fx": {
        replayFx(effects, row.m, row.a);
        break;
      }
      case "sfx": {
        effects.game.audio.play(row.n, row.x ?? undefined, row.z ?? undefined);
        break;
      }
      case "float": {
        hud.floatText(row.x, row.y, row.z, row.text, row.cls);
        break;
      }
      case "feed": {
        hud.feedKill(row.killer, row.victim, row.kid === localSeat, row.vid === localSeat);
        break;
      }
      default: {
        break;
      }
    }
  }
};

/** Install the recorders on every choke point; `null` sink removes them. */
export const setRecorders = (
  effects: Effects,
  hud: Hud,
  sink: ((row: FxRecord) => void) | null,
): void => {
  const { audio } = effects.game;
  if (!sink) {
    effects.recorder = null;
    audio.recorder = null;
    hud.floatRecorder = null;
    hud.feedRecorder = null;
    return;
  }
  effects.recorder = (m, a) => sink({ a, k: "fx", m });
  audio.recorder = (n, x, z) => {
    if (!isLocalSound(n)) {
      sink({ k: "sfx", n, x, z });
    }
  };
  hud.floatRecorder = (x, y, z, text, cls) => sink({ cls, k: "float", text, x, y, z });
  hud.feedRecorder = (killer, victim, kid, vid) => sink({ k: "feed", kid, killer, victim, vid });
};
