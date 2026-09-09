import type { Player } from "@vibedgames/multiplayer";
import { BOOSTER_KINDS, SHIELD_MAX, SHIELD_MOD_KINDS } from "../shared/constants";
import type {
  BoostNetState,
  PlayerNetState,
  SerializedBeam,
  ShieldModNetState,
  Vec,
} from "../shared/constants";

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

/** Decode one serialized beam off the wire; null when a required field is missing. */
export const readWireBeam = (entry: WireValue): SerializedBeam | null => {
  const b = asWireRecord(entry);
  if (!b) {
    return null;
  }
  const hx = wireNum(b["hx"]);
  const hy = wireNum(b["hy"]);
  const tx = wireNum(b["tx"]);
  const ty = wireNum(b["ty"]);
  const tint = wireNum(b["tint"]);
  const width = wireNum(b["width"]);
  if (hx === null || hy === null || tx === null || ty === null || tint === null || width === null) {
    return null;
  }
  const beam: SerializedBeam = {
    exploding: b["exploding"] === true,
    explosionRadius: wireNum(b["explosionRadius"]) ?? 0,
    hx,
    hy,
    tint,
    tx,
    ty,
    width,
  };
  const chainRaw = b["chain"];
  if (Array.isArray(chainRaw)) {
    const pts: Vec[] = [];
    for (const pt of chainRaw) {
      const r = asWireRecord(pt);
      if (!r) {
        continue;
      }
      const px = wireNum(r["x"]);
      const py = wireNum(r["y"]);
      if (px !== null && py !== null) {
        pts.push({ x: px, y: py });
      }
    }
    if (pts.length >= 2) {
      beam.chain = pts;
    }
  }
  if (b["glaive"] === true) {
    beam.glaive = true;
  }
  if (b["mine"] === true) {
    beam.mine = true;
  }
  if (b["orb"] === true) {
    beam.orb = true;
  }
  const power = wireNum(b["power"]);
  if (power !== null) {
    beam.power = power;
  }
  return beam;
};

export const readWireBeams = (raw: WireValue | undefined): SerializedBeam[] => {
  const beams: SerializedBeam[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const beam = readWireBeam(entry);
      if (beam) {
        beams.push(beam);
      }
    }
  }
  return beams;
};

export const readWireShieldMod = (raw: WireValue | undefined): ShieldModNetState | null => {
  const modRaw = asWireRecord(raw);
  if (!modRaw) {
    return null;
  }
  const kind = SHIELD_MOD_KINDS.find((k) => k === modRaw["kind"]);
  if (!kind) {
    return null;
  }
  return {
    active: modRaw["active"] === true,
    kind,
    phased: modRaw["phased"] === true,
    until: wireNum(modRaw["until"]) ?? 0,
  };
};

export const readWireBoosts = (raw: WireValue | undefined): BoostNetState[] => {
  const boosts: BoostNetState[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const r = asWireRecord(entry);
      if (!r) {
        continue;
      }
      const kind = BOOSTER_KINDS.find((k) => k === r["kind"]);
      const until = wireNum(r["until"]);
      if (kind && until !== null) {
        boosts.push({ kind, until });
      }
    }
  }
  return boosts;
};

export const readWireSentry = (raw: WireValue | undefined): PlayerNetState["sentry"] => {
  const sentryRaw = asWireRecord(raw);
  if (!sentryRaw) {
    return null;
  }
  const sx = wireNum(sentryRaw["x"]);
  const sy = wireNum(sentryRaw["y"]);
  const sUntil = wireNum(sentryRaw["until"]);
  if (sx === null || sy === null || sUntil === null) {
    return null;
  }
  return { until: sUntil, x: sx, y: sy };
};

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
    beams: readWireBeams(s["beams"]),
    boosts: readWireBoosts(s["boosts"]),
    invuln: s["invuln"] === true,
    level: wireNum(s["level"]) ?? 1,
    overHp: wireNum(s["overHp"]) ?? 0,
    present: s["present"] !== false,
    sectorScore: wireNum(s["sectorScore"]) ?? 0,
    sentry: readWireSentry(s["sentry"]),
    shieldHp: wireNum(s["shieldHp"]) ?? SHIELD_MAX,
    shieldMod: readWireShieldMod(s["shieldMod"]),
    streak: wireNum(s["streak"]) ?? 0,
    tesla: s["tesla"] === true,
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
