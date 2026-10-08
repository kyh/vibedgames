import type { Player } from "@vibedgames/multiplayer";
import { SHIELD_MAX, SHIELD_MOD_KINDS } from "../shared/constants";
import type { PlayerNetState, ShieldModNetState } from "../shared/constants";

/** Decoders for peer wire state: JSON records off the multiplayer socket → typed domain values. */

/** One entry of a peer's wire-state record — the multiplayer owner contract
 *  leaves entries undecoded; the wire* helpers below parse them into domain
 *  values. Wire traffic is JSON, so plain records, arrays and primitives are
 *  the whole vocabulary. */
export type WireValue = NonNullable<Player["state"]>[string];

/** A JSON record off the wire, entries not yet decoded. */
export type WireRecord = Record<string, WireValue>;

export const isWireRecord = (v: WireValue | undefined): v is WireRecord => v instanceof Object;

export const asWireRecord = (v: WireValue | undefined): WireRecord | null =>
  isWireRecord(v) ? v : null;

/** Decode a wire number. NaN never appears in legal traffic, and `n === v`
 *  rejects it along with every non-number, so the copy-compare is exact. */
export const wireNum = (v: WireValue | undefined): number | null => {
  const n = Number(v);
  return n === v ? n : null;
};

export const wireStr = (v: WireValue | undefined): string | null => {
  const s = String(v);
  return s === v ? s : null;
};

const readShieldMod = (s: WireRecord): ShieldModNetState | null => {
  const kind = SHIELD_MOD_KINDS.find((k) => k === s["mod"]);
  if (!kind) {
    return null;
  }
  return { active: s["modOn"] === true, kind, phased: s["phased"] === true };
};

/** A peer's flat wire state (shared/wire.ts playerToWire), decoded. */
export const readNetState = (player: Player | undefined): PlayerNetState | null => {
  const s = player?.state;
  if (!s) {
    return null;
  }
  const x = wireNum(s["x"]);
  const y = wireNum(s["y"]);
  const angle = wireNum(s["angle"]);
  if (x === null || y === null || angle === null) {
    return null;
  }
  return {
    alive: s["alive"] !== false,
    angle,
    invuln: s["invuln"] === true,
    level: wireNum(s["level"]) ?? 1,
    magnet: s["magnet"] === true,
    nitro: s["nitro"] === true,
    overHp: wireNum(s["overHp"]) ?? 0,
    present: s["present"] !== false,
    sectorScore: wireNum(s["sectorScore"]) ?? 0,
    shieldHp: wireNum(s["shieldHp"]) ?? SHIELD_MAX,
    shieldMod: readShieldMod(s),
    streak: wireNum(s["streak"]) ?? 0,
    t: wireNum(s["t"]) ?? 0,
    tesla: s["tesla"] === true,
    twin: s["twin"] === true,
    vx: wireNum(s["vx"]) ?? 0,
    vy: wireNum(s["vy"]) ?? 0,
    weaponName: wireStr(s["weaponName"]) ?? "",
    windup: wireNum(s["windup"]) ?? 0,
    x,
    xp: wireNum(s["xp"]) ?? 0,
    y,
  };
};

/** Position of a raw string in a kind table (-1 when it names no kind). */
export const kindIndex = (kinds: readonly string[], name: string): number => kinds.indexOf(name);
