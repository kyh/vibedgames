import { WEAPONS_SPECIAL, baseWeaponForLevel, scaleWeaponForLevel } from "../shared/constants";
import type { Vec, Weapon } from "../shared/constants";
import { decodeTarget, encodeTarget } from "../sys/beam";
import { REFLECT_WEAPON, SENTRY_WEAPON } from "../sys/volley";
import type { FireKind, FireSpec } from "../sys/volley";
import { asWireRecord, wireNum, wireStr } from "./wire-read";
import type { WireRecord, WireValue } from "./wire-read";

/**
 * The `fire` event: one trigger pull, ~60 bytes. Weapon `w` is a
 * WEAPONS_SPECIAL index (append-only, like item drops) scaled to level `l`,
 * or one of the negative codes below. Keys are one letter on purpose — a
 * PLASMA CONE sends fourteen of these a second.
 */

/** The shooter's base weapon at its level. */
export const FIRE_BASE = -1;
/** A SENTRY turret bolt (fires the unscaled SENTRY stat block). */
export const FIRE_TURRET = -2;
/** A REFLECT return bolt. */
export const FIRE_REFLECT = -3;

const KIND_CODES: readonly FireKind[] = ["volley", "turret", "reflect", "chain"];

const q1 = (n: number): number => Math.round(n * 10) / 10;
const q3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The weapon a code names at a level, or null for a code this build lacks. */
export const fireWeapon = (code: number, level: number): Weapon | null => {
  if (code === FIRE_BASE) {
    return baseWeaponForLevel(level);
  }
  if (code === FIRE_TURRET) {
    return SENTRY_WEAPON;
  }
  if (code === FIRE_REFLECT) {
    return REFLECT_WEAPON;
  }
  const w = WEAPONS_SPECIAL[code];
  return w ? scaleWeaponForLevel(w, level) : null;
};

export const encodeFire = (spec: FireSpec): WireRecord => {
  const out: WireRecord = {
    a: q3(spec.angle),
    t: Math.round(spec.t),
    w: spec.code,
    x: q1(spec.x),
    y: q1(spec.y),
  };
  if (spec.kind !== "volley") {
    out["k"] = KIND_CODES.indexOf(spec.kind);
  }
  if (spec.code >= 0 || spec.code === FIRE_BASE) {
    out["l"] = spec.level;
  }
  if (spec.weapon.jitterDeg > 0 || spec.weapon.sfx === "plasma") {
    out["s"] = spec.seed;
  }
  if (spec.twin !== null) {
    out["tw"] = q3(spec.twin);
  }
  if (spec.lock) {
    out["h"] = encodeTarget(spec.lock);
  }
  if (spec.twinLock) {
    out["ht"] = encodeTarget(spec.twinLock);
  }
  if (spec.chain) {
    out["c"] = spec.chain.flatMap((p) => [q1(p.x), q1(p.y)]);
  }
  return out;
};

const readChain = (raw: WireValue | undefined): Vec[] | null => {
  if (!Array.isArray(raw)) {
    return null;
  }
  const pts: Vec[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const x = wireNum(raw[i]);
    const y = wireNum(raw[i + 1]);
    if (x !== null && y !== null) {
      pts.push({ x, y });
    }
  }
  return pts.length >= 2 ? pts : null;
};

const readLock = (raw: WireValue | undefined) => {
  const code = wireStr(raw);
  return code === null ? null : decodeTarget(code);
};

/** A received `fire` payload as the spec its shooter built, or null. */
export const decodeFire = (payload: WireValue): FireSpec | null => {
  const p = asWireRecord(payload);
  if (!p) {
    return null;
  }
  const t = wireNum(p["t"]);
  const code = wireNum(p["w"]);
  const x = wireNum(p["x"]);
  const y = wireNum(p["y"]);
  const angle = wireNum(p["a"]);
  const kind = KIND_CODES[wireNum(p["k"]) ?? 0];
  if (t === null || code === null || x === null || y === null || angle === null || !kind) {
    return null;
  }
  const level = wireNum(p["l"]) ?? 1;
  const weapon = fireWeapon(code, level);
  if (!weapon) {
    return null;
  }
  const chain = readChain(p["c"]);
  if (kind === "chain" && !chain) {
    return null;
  }
  return {
    angle,
    chain,
    code,
    kind,
    level,
    lock: readLock(p["h"]),
    seed: wireNum(p["s"]) ?? 0,
    t,
    twin: wireNum(p["tw"]),
    twinLock: readLock(p["ht"]),
    weapon,
    x,
    y,
  };
};
