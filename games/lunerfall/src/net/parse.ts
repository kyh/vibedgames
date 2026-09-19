import { ENEMY_NAMES, HERO_NAMES } from "../data/animations";
import type { EnemyName, HeroName } from "../data/animations";
import { isJsonObject } from "./json";
import type { JsonValue } from "./json";
import { isSnapshot } from "./snapshot";
import type { NetInput, Snapshot } from "./snapshot";

// Boundary parsers — validate wire JSON values into our types without casts.
const num = (v: JsonValue | undefined): v is number => Number.isFinite(v);
const bool = (v: JsonValue | undefined): v is boolean => v === true || v === false;
export const readNetInput = (v: JsonValue | undefined): NetInput | null => {
  if (!isJsonObject(v)) {
    return null;
  }
  const o = v;
  if (!bool(o.left) || !bool(o.right) || !bool(o.up) || !bool(o.down) || !bool(o.jumpHeld)) {
    return null;
  }
  if (!num(o.j) || !num(o.d) || !num(o.a) || !num(o.s)) {
    return null;
  }
  return {
    a: o.a,
    d: o.d,
    down: o.down,
    j: o.j,
    jumpHeld: o.jumpHeld,
    left: o.left,
    right: o.right,
    s: o.s,
    up: o.up,
  };
};
export const parseHero = (v: JsonValue | undefined): HeroName | null =>
  HERO_NAMES.find((h) => h === v) ?? null;
export const parseEnemy = (v: string): EnemyName => ENEMY_NAMES.find((e) => e === v) ?? "warrior";
export const readSnapshot = (shared: Record<string, JsonValue> | null): Snapshot | null => {
  const s = shared?.snap;
  return isSnapshot(s) ? s : null;
};
