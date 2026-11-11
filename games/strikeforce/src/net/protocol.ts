// Match protocol. The host runs the rules (rules.ts) and publishes the match
// under one shared-state key; every client publishes its own body in player
// state and sends the host intents. Nothing here is backward compatible: a
// wire change bumps ROOM_PREFIX so old tabs never share a room with new ones.
import type { JsonRecord, JsonValue } from "@vibedgames/multiplayer";

import type { ChargeState, Fighter, MatchState, Phase, RoundEnd, Team } from "./rules";
import { isRecord, isStr, numOr, nums } from "./wire";

export const PARTY = "vg-server";
export const LOBBY = "strikeforce";
export const ROOM_PREFIX = "strikeforce-v1-";
/** Eight a side. Overflow rooms take the seventeenth. */
export const MAX_PLAYERS = 16;
/** No room in this long (rendered frames): play alone in warmup. */
export const FALLBACK_MS = 6000;

/** Host match snapshot rate. */
export const MATCH_HZ = 10;
/** Own-body send rate. */
export const BODY_HZ = 20;
export const MATCH_KEY = "match";

/** Events. Payloads are positional arrays to keep the wire small. */
export const EV = {
  /** guest → host: `[barrelIndex, damage, px, py, pz, dx, dy, dz]` */
  barrel: "barrel",
  /** defender → host: nothing */
  defuse: "defuse",
  /** shooter → host: `[victimId, damage, head(1|0)]` */
  hit: "hit",
  /** host → victim: `[damage, fromX, fromY, fromZ, hpLeft]` */
  hurt: "hurt",
  /** host → everyone: `[killerId, victimId, head(1|0)]` */
  kill: "kill",
  /** carrier → host: site index */
  plant: "plant",
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
  /** the round this body is playing */
  r: number;
  /** deployed (past the title screen): 1 */
  d: number;
}

export const TEAM_NAME = ["Gold", "Steel"] as const;
export const TEAM_COLOR = ["#ffb347", "#8fb8d8"] as const;

/** Build the room id from a squad code (`?room=`). */
export const roomId = (code: string): string =>
  ROOM_PREFIX +
  code
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "")
    .slice(0, 16);

/** Round for the wire: three decimals is a millimetre, or a milliradian. */
export const q3 = (v: number): number => Math.round(v * 1000) / 1000;

const PHASES: readonly Phase[] = ["warmup", "freeze", "live", "planted", "post", "over"];
const CHARGES: readonly ChargeState[] = [
  "none",
  "carried",
  "dropped",
  "planted",
  "defused",
  "detonated",
];
const ENDS: readonly RoundEnd[] = ["eliminated", "time", "detonated", "defused"];
const asTeam = (v: number | undefined): Team => (v === 1 ? 1 : 0);

/** The match as the host publishes it. */
export const encodeMatch = (s: MatchState, stamp: number): JsonRecord => {
  const ro: JsonRecord = {};
  for (const [id, f] of s.roster) {
    // `back` (server ms) rides along so a promoted host keeps warmup respawns.
    ro[id] = [
      f.team,
      f.alive ? 1 : 0,
      Math.round(f.hp),
      f.kills,
      f.deaths,
      f.slot,
      Math.round(f.back),
    ];
  }
  const c = s.charge;
  return {
    at: s.attack,
    cc: c.carrier,
    ch: [CHARGES.indexOf(c.state), q3(c.x), q3(c.y), q3(c.z), c.site],
    e: Math.round(s.ends),
    ph: PHASES.indexOf(s.phase),
    r: s.round,
    ro,
    s: [s.score[0], s.score[1]],
    t: Math.round(stamp),
    w: s.last ? [s.last.winner, ENDS.indexOf(s.last.why)] : null,
  };
};

const decodeFighter = (raw: JsonValue | undefined): Fighter | null => {
  const v = nums(raw, 6);
  if (!v) {
    return null;
  }
  const [team, alive, hp, kills, deaths, slot, back] = v;
  return {
    alive: alive === 1,
    back: back ?? 0,
    deaths: deaths ?? 0,
    hp: hp ?? 0,
    kills: kills ?? 0,
    slot: slot ?? 0,
    team: asTeam(team),
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
  const ch = nums(raw.ch, 5) ?? [0, 0, 0, 0, -1];
  const score = nums(raw.s, 2) ?? [0, 0];
  const w = nums(raw.w, 2);
  return {
    stamp: numOr(raw.t, 0),
    state: {
      attack: asTeam(numOr(raw.at, 0)),
      charge: {
        carrier: isStr(raw.cc) ? raw.cc : "",
        site: ch[4] ?? -1,
        state: CHARGES[ch[0] ?? 0] ?? "none",
        x: ch[1] ?? 0,
        y: ch[2] ?? 0,
        z: ch[3] ?? 0,
      },
      ends: numOr(raw.e, 0),
      last: w ? { why: ENDS[w[1] ?? 0] ?? "eliminated", winner: asTeam(w[0]) } : null,
      phase: PHASES[numOr(raw.ph, 0)] ?? "warmup",
      roster,
      round: numOr(raw.r, 0),
      score: [score[0] ?? 0, score[1] ?? 0],
    },
  };
};
