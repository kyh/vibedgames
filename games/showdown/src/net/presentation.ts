import * as THREE from "three";
import type { SoundName } from "../audio-recipes";
import { isSoundName } from "../audio-recipes";
import type { Bomb, Bullet, Combat } from "../combat/combat";
import type { Brawler } from "../entities/brawler";
import type { Effects } from "../fx/effects";
import type { Hud } from "../hud";
import type { JsonObject, JsonValue } from "../json";
import { isJsonNumber as isNum, isJsonObject as isObj, isJsonString as isStr } from "../json";

/** Effects methods that replay on guests, keyed by name. */
export type FxMethod =
  | "flash"
  | "impact"
  | "burst"
  | "muzzle"
  | "slash"
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
  | { k: "fx"; m: FxMethod; a: number[]; o?: number }
  | { k: "sfx"; n: SoundName; x: number | null; z: number | null; o?: number }
  | { k: "float"; x: number; y: number; z: number; text: string; cls: string }
  | { k: "feed"; killer: string | null; victim: string; kid: string | null; vid: string }
  | ShotRow
  | LobRow
  | { k: "gone"; i: number };

/** A bullet left `o`'s weapon: host id, super flag, spawn point (cm), heading (mrad), speed (cm/s). */
export type ShotRow = {
  k: "shot";
  i: number;
  o: number;
  s: number;
  x: number;
  z: number;
  d: number;
  v: number;
};

/** A bomb left `o`'s hand from (x, y, z) towards (tx, tz), all in cm. */
export type LobRow = {
  k: "lob";
  o: number;
  s: number;
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
};

export type FxRecorder = (m: FxMethod, a: number[]) => void;

export type SfxRecorder = (n: SoundName, x: number | null, z: number | null) => void;

export type FloatRecorder = (x: number, y: number, z: number, text: string, cls: string) => void;

export type FeedRecorder = (
  killer: string | null,
  victim: string,
  kid: string | null,
  vid: string,
) => void;

const LOCAL_SOUNDS: ReadonlySet<SoundName> = new Set<SoundName>([
  "click",
  "count",
  "gas",
  "go",
  "lose",
  "ready",
  "win",
]);

export const isLocalSound = (name: SoundName) => LOCAL_SOUNDS.has(name);

const FX_METHODS: ReadonlySet<string> = new Set<FxMethod>([
  "flash",
  "impact",
  "burst",
  "muzzle",
  "slash",
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

const isFxRow = (v: JsonObject) =>
  isFxMethod(v.m) && Array.isArray(v.a) && v.a.every((n) => isNum(n));

const isSfxRow = (v: JsonObject) =>
  isStr(v.n) && isSoundName(v.n) && (v.x === null || isNum(v.x)) && (v.z === null || isNum(v.z));

const isFloatRow = (v: JsonObject) =>
  isNum(v.x) && isNum(v.y) && isNum(v.z) && isStr(v.text) && isStr(v.cls);

const isFeedRow = (v: JsonObject) =>
  (v.killer === null || isStr(v.killer)) &&
  isStr(v.victim) &&
  (v.kid === null || isStr(v.kid)) &&
  isStr(v.vid);

const isWhole = (v: JsonValue | undefined) => isNum(v) && Number.isSafeInteger(v);

const isShotRow = (v: JsonObject) =>
  ["i", "o", "s", "x", "z", "d", "v"].every((key) => isWhole(v[key]));

const isLobRow = (v: JsonObject) =>
  ["o", "s", "x", "y", "z", "tx", "tz"].every((key) => isWhole(v[key]));

const isGoneRow = (v: JsonObject) => isWhole(v.i);

const hasActor = (v: JsonObject) => v.o === undefined || isWhole(v.o);

const isActorFxRow = (v: JsonObject) => isFxRow(v) && hasActor(v);
const isActorSfxRow = (v: JsonObject) => isSfxRow(v) && hasActor(v);

const rowGuard = (kind: JsonValue | undefined) => {
  switch (kind) {
    case "fx": {
      return isActorFxRow;
    }

    case "sfx": {
      return isActorSfxRow;
    }

    case "float": {
      return isFloatRow;
    }

    case "feed": {
      return isFeedRow;
    }

    case "shot": {
      return isShotRow;
    }

    case "lob": {
      return isLobRow;
    }

    case "gone": {
      return isGoneRow;
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

  const guard = rowGuard(v.k);

  return guard !== null && guard(v);
};

/** The host's fx batch, validated row by row; malformed rows are dropped. */
export const parseFxBatch = (v: JsonValue | undefined) =>
  Array.isArray(v) ? v.filter((row) => isFxRecord(row)) : [];

const COLOR = new THREE.Color();
const arg = (a: readonly number[], i: number) => a[i] ?? 0;
const color = (a: readonly number[], i: number) => COLOR.setHex(arg(a, i));

/** Replay one recorded Effects call. */
export const replayFx = (effects: Effects, m: FxMethod, a: readonly number[]) => {
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

    case "slash": {
      effects.slash(
        arg(a, 0),
        arg(a, 1),
        arg(a, 2),
        arg(a, 3),
        arg(a, 4),
        arg(a, 5),
        color(a, 6),
        arg(a, 7) > 0.5,
        a[8] ?? 0.13,
      );
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

/** Replay a batch on a guest. `localSeat` highlights the guest's own name in the feed; projectile rows are the guest view's. */
export const replayBatch = (
  effects: Effects,
  hud: Hud,
  rows: readonly FxRecord[],
  localSeat: string | null,
) => {
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

const round2 = (n: number) => Math.round(n * 100) / 100;
const roundOrNull = (n: number | null) => (n === null ? null : round2(n));
const cm = (n: number) => Math.round(n * 100);

/** How the host names brawlers on the wire: their index in the roster it publishes. */
export interface RecordContext {
  /** Roster index of the brawler presenting its own action right now, or -1. */
  actor: () => number;
  /** Roster index of a brawler, or -1 when it is not in the roster. */
  indexOf: (b: Brawler) => number;
}

const shotRow: (bullet: Bullet, o: number) => ShotRow = (bullet, o) => ({
  d: Math.round(Math.atan2(bullet.dx, bullet.dz) * 1000),
  i: bullet.netId,
  k: "shot",
  o,
  s: bullet.isSuper ? 1 : 0,
  v: cm(bullet.speed),
  x: cm(bullet.x),
  z: cm(bullet.z),
});

const lobRow: (bomb: Bomb, o: number) => LobRow = (bomb, o) => ({
  k: "lob",
  o,
  s: bomb.isSuper ? 1 : 0,
  tx: cm(bomb.tx),
  tz: cm(bomb.tz),
  x: cm(bomb.sx),
  y: cm(bomb.sy),
  z: cm(bomb.sz),
});

const UNNAMED: RecordContext = { actor: () => -1, indexOf: () => -1 };

const clearRecorders = (effects: Effects, hud: Hud, combat: Combat) => {
  effects.recorder = null;
  effects.game.audio.recorder = null;
  hud.floatRecorder = null;
  hud.feedRecorder = null;
  combat.shotRecorder = null;
  combat.lobRecorder = null;
  combat.goneRecorder = null;
};

/** Install the recorders on every choke point; a `null` sink removes them. */
export const setRecorders = (
  effects: Effects,
  hud: Hud,
  combat: Combat,
  sink: ((row: FxRecord) => void) | null,
  context: RecordContext = UNNAMED,
) => {
  if (!sink) {
    clearRecorders(effects, hud, combat);

    return;
  }

  effects.recorder = (m, a) => {
    const o = context.actor();
    const args = a.map((n) => round2(n));
    sink(o === -1 ? { a: args, k: "fx", m } : { a: args, k: "fx", m, o });
  };

  effects.game.audio.recorder = (n, x, z) => {
    if (isLocalSound(n)) {
      return;
    }

    const o = context.actor();
    const at = { x: roundOrNull(x), z: roundOrNull(z) };
    sink(o === -1 ? { ...at, k: "sfx", n } : { ...at, k: "sfx", n, o });
  };

  hud.floatRecorder = (x, y, z, text, cls) => {
    sink({ cls, k: "float", text, x: round2(x), y: round2(y), z: round2(z) });
  };

  hud.feedRecorder = (killer, victim, kid, vid) => {
    sink({ k: "feed", kid, killer, victim, vid });
  };

  combat.shotRecorder = (bullet) => {
    const o = context.indexOf(bullet.owner);

    if (o !== -1) {
      sink(shotRow(bullet, o));
    }
  };

  combat.lobRecorder = (bomb) => {
    const o = context.indexOf(bomb.owner);

    if (o !== -1) {
      sink(lobRow(bomb, o));
    }
  };

  combat.goneRecorder = (bullet) => {
    sink({ i: bullet.netId, k: "gone" });
  };
};
