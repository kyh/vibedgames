// Deathmatch protocol. The host runs the rules (rules.ts) and publishes the match
// under one shared-state key; every client publishes its own body in player
// state and sends the host intents. Nothing here is backward compatible: a
// wire change bumps ROOM_PREFIX so old tabs never share a room with new ones.
import type { JsonRecord, JsonValue } from "@vibedgames/multiplayer";

import type { Fighter, MatchState, Phase } from "./rules";
import { isRecord, isStr, numOr, nums } from "./wire";

export const PARTY = "vg-server";
export const LOBBY = "strikeforce";
export const ROOM_PREFIX = "strikeforce-v4-";
/** A full dock. Overflow rooms take the seventeenth. */
export const MAX_PLAYERS = 16;
/** No room in this long (rendered frames): play alone in warmup. */
export const FALLBACK_MS = 6000;

/** Host match snapshot rate. */
export const MATCH_HZ = 10;
/** Own-body send rate. */
export const BODY_HZ = 20;
export const MATCH_KEY = "match";
/** The host's bots: `{ [botId]: [t, x, y, z, yaw, pitch] }`, at BODY_HZ. */
export const BOTS_KEY = "bots";

/** Events. Payloads are positional arrays to keep the wire small. */
export const EV = {
  /** guest → host: `[barrelIndex, damage, px, py, pz, dx, dy, dz]` */
  barrel: "barrel",
  /** shooter → host: `[victimId, damage, head(1|0)]` */
  hit: "hit",
  /** host → victim: `[damage, fromX, fromY, fromZ, hpLeft]` */
  hurt: "hurt",
  /** host → everyone: `[killerId, victimId, head(1|0)]` */
  kill: "kill",
  /** anyone → others: `[mx, my, mz, ex, ey, ez, weapon(0 rifle | 1 pistol)]` */
  shot: "shot",
} as const;

/** Own body, as every client publishes it in player state. */
export interface BodyWire {
  /** serverNow() stamp */
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** crouching: 1 */
  c: number;
  /** alive: 1 */
  a: number;
  hp: number;
  /** the life (see rules.ts) this body is playing */
  l: number;
  /** deployed (past the title screen): 1 */
  d: number;
}

/** Build the room id from a squad code (`?room=`). */
export const roomId = (code: string): string =>
  ROOM_PREFIX +
  code
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "")
    .slice(0, 16);

/** Round for the wire: three decimals is a millimetre, or a milliradian. */
export const q3 = (v: number): number => Math.round(v * 1000) / 1000;

const PHASES: readonly Phase[] = ["warmup", "live", "over"];

/** The match as the host publishes it. */
export const encodeMatch = (s: MatchState, stamp: number): JsonRecord => {
  const ro: JsonRecord = {};
  for (const [id, f] of s.roster) {
    // `back` (server ms) rides along so a promoted host keeps respawns; `life`
    // is what a client places its body by.
    ro[id] = [f.alive ? 1 : 0, Math.round(f.hp), f.kills, f.deaths, Math.round(f.back), f.life];
  }
  return {
    e: Math.round(s.ends),
    ld: s.champ,
    ph: PHASES.indexOf(s.phase),
    r: s.round,
    ro,
    t: Math.round(stamp),
  };
};

const decodeFighter = (raw: JsonValue | undefined): Fighter | null => {
  const v = nums(raw, 6);
  if (!v) {
    return null;
  }
  const [alive, hp, kills, deaths, back, life] = v;
  return {
    alive: alive === 1,
    back: back ?? 0,
    deaths: deaths ?? 0,
    hp: hp ?? 0,
    kills: kills ?? 0,
    life: life ?? 0,
  };
};

/** A client's read of the host's match, or null if it is not one. */
export const decodeMatch = (
  raw: JsonValue | undefined,
): { state: MatchState; stamp: number } | null => {
  if (!isRecord(raw) || !isRecord(raw.ro)) {
    return null;
  }
  const roster = new Map<string, Fighter>();
  for (const [id, f] of Object.entries(raw.ro)) {
    const fighter = decodeFighter(f);
    if (fighter) {
      roster.set(id, fighter);
    }
  }
  return {
    stamp: numOr(raw.t, 0),
    state: {
      champ: isStr(raw.ld) ? raw.ld : "",
      ends: numOr(raw.e, 0),
      phase: PHASES[numOr(raw.ph, 0)] ?? "warmup",
      roster,
      round: numOr(raw.r, 0),
    },
  };
};
