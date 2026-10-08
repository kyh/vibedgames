// The host's sim on the wire, split by how often each part changes:
//   f         every tick: the host's clock stamp, the phase clock, one integer
//             row per brawler and the few short-lived pose cues in flight
//   m         on change: generation, seed, winner and the roster's identities
//   bx/cu/br  on change: loot boxes, power cubes, destroyed tiles
// Rows are integers at fixed scales with trailing zeros dropped, so a frame for
// eight brawlers stays well under a kilobyte; identities never repeat per
// tick. Bullets and bombs are not state at all: their spawns ride the fx batch
// and every client flies them locally. A promoted host rebuilds the brawl from
// these same keys (`assembleWorld`). FX ride beside them (fx/fs).
import type { BrawlerId } from "../config";
import { BRAWLERS, isBrawlerId } from "../config";
import { EVADE } from "../entities/evasion";
import type { EvasionState } from "../entities/evasion";
import type { MeleeCue } from "../entities/melee-pose";
import type { LeapArc } from "../entities/movement";
import { rangedPoseDuration } from "../entities/ranged-pose";
import type { RangedCue } from "../entities/ranged-pose";
import type { JsonObject, JsonValue } from "../json";
import { isJsonNumber as isNum, isJsonObject as isObj, isJsonString as isStr } from "../json";
import type { IntentAck } from "./intent-ack";

export type NetPhase = "countdown" | "playing" | "ended";

/** `[id, owner, kit, name, hue × 1000]` — `id` is `p:<playerId>` for a human seat, `bot:<n>` for a bot. */
export type NetIdentity = [string, string | null, BrawlerId, string, number];

export type NetMatch = {
  g: number;
  seed: number;
  /** Winner's name once the brawl is decided. */
  w: string | null;
  /** Roster version; frames name the one their rows follow. */
  v: number;
  b: NetIdentity[];
};

export type NetFrame = {
  /** Host clock (performance.now, ms) when the frame left. */
  t: number;
  s: number;
  g: number;
  v: number;
  /** Phase index into PHASES. */
  p: number;
  /** Countdown seconds left, or match seconds, × 100. */
  c: number;
  /** One row per roster entry, in roster order (see ROW). */
  b: number[][];
  /** `[rosterIndex, cueKind, ...]` for every leap, roll, swing and shot pose in flight. */
  q: number[][];
};

const PHASES: readonly NetPhase[] = ["countdown", "playing", "ended"];

/** Row slots; trailing zeros are dropped on the wire and read back as zero. */
const X = 0;
const Z = 1;
const FACING = 2;
const HP = 3;
const FLAGS = 4;
const AMMO = 5;
const CHARGE = 6;
const CUBES = 7;
const KILLS = 8;
const RANK = 9;
const EVADE_CD = 10;
const ACK = 11;
const ACK_AGE = 12;
const EVADE_RESULT = 13;
const KNOCK_SEQ = 14;
const KNOCK_X = 15;
const KNOCK_Z = 16;
const ROW_LENGTH = 17;

const ALIVE = 1;
const CONCEALED = 2;

const CUE_LEAP = 1;
const CUE_ROLL = 2;
const CUE_SWING = 3;
const CUE_SHOT = 4;

/** Positions in centimetres, angles in hundredths of a radian, durations in ms. */
const POS = 100;
const ANGLE = 100;
const MS = 1000;
/** Ammo, charge and cooldowns in hundredths; knockback in tenths of a unit per second. */
const UNIT = 100;
const KNOCK = 10;
const HUE = 1000;

/** World half-extent plus margin — a coordinate outside this is nonsense. */
const MAX_COORD = 40;
const MAX_ROSTER = 16;
const MAX_NAME = 24;
const MAX_KNOCK = 60;

export interface Identity {
  id: string;
  owner: string | null;
  kit: BrawlerId;
  name: string;
  hue: number;
}

export interface MatchState {
  gen: number;
  seed: number;
  winner: string | null;
  rosterVersion: number;
  roster: Identity[];
}

/** One brawler as a frame describes it, at the frame's stamp. */
export interface BrawlerState {
  x: number;
  z: number;
  facing: number;
  hp: number;
  alive: boolean;
  /** In a bush and not recently revealed. */
  concealed: boolean;
  /** Whole shots in hand, and progress towards the next. */
  ammo: number;
  reload: number;
  charge: number;
  cubes: number;
  kills: number;
  rank: number;
  evadeCooldown: number;
  /** Newest intent the host applied to this body, and for how long (ms). Zero for bots. */
  ack: number;
  ackAge: number;
  /** Signed sequence of the last evade processed: negative when refused. */
  evade: number;
  /** Bumps with every hit that shoved this body; `knockX/Z` is the shove it set. */
  knockSeq: number;
  knockX: number;
  knockZ: number;
  leap: LeapArc | null;
  evasion: EvasionState | null;
  melee: MeleeCue | null;
  ranged: RangedCue | null;
}

export interface FrameState {
  t: number;
  seq: number;
  gen: number;
  rosterVersion: number;
  phase: NetPhase;
  /** Countdown seconds left while counting down, else match seconds. */
  clock: number;
  brawlers: BrawlerState[];
}

export interface BoxState {
  /** Index into `world.boxSpots`. */
  i: number;
  hp: number;
}

export interface CubeSpot {
  x: number;
  z: number;
}

/** Everything a promoted host needs to adopt the brawl. */
export interface WorldState {
  match: MatchState;
  frame: FrameState;
  boxes: BoxState[];
  cubes: CubeSpot[];
  broken: number[];
}

// ── encoding (host) ──

/** What the host reads off a brawler to write its row. */
export interface RowSource {
  readonly x: number;
  readonly z: number;
  facing: number;
  hp: number;
  alive: boolean;
  inBush: boolean;
  revealT: number;
  ammo: number;
  reloadT: number;
  superCharge: number;
  cubes: number;
  kills: number;
  rank: number;
  evadeCooldown: number;
  readonly ack: Pick<IntentAck, "age" | "seq">;
  evadeResult: number;
  knockSeq: number;
  knockX: number;
  knockZ: number;
  leap: LeapArc | null;
  evasion: EvasionState | null;
  meleeCue: MeleeCue | null;
  rangedCue: RangedCue | null;
}

export interface FrameSource {
  readonly brawlers: readonly RowSource[];
  generation: number;
  state: string;
  countdownT: number;
  matchTime: number;
}

export interface IdentitySource {
  readonly netId: string;
  readonly owner: string | null;
  readonly def: { readonly id: BrawlerId };
  readonly name: string;
  readonly hueShift: number;
}

const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));
const scaled = (value: number, scale: number): number => Math.round(value * scale);

const encodeRow = (b: RowSource, simMs: number): number[] => {
  const row = [
    scaled(b.x, POS),
    scaled(b.z, POS),
    scaled(wrapAngle(b.facing), ANGLE),
    Math.max(0, Math.round(b.hp)),
    (b.alive ? ALIVE : 0) + (b.inBush && b.revealT <= 0 ? CONCEALED : 0),
    scaled(b.ammo + b.reloadT, UNIT),
    scaled(b.superCharge, UNIT),
    b.cubes,
    b.kills,
    b.rank,
    scaled(b.evadeCooldown, UNIT),
    b.ack.seq,
    b.ack.age(simMs),
    b.evadeResult,
    b.knockSeq,
    scaled(b.knockX, KNOCK),
    scaled(b.knockZ, KNOCK),
  ];
  while (row.length > 0 && row.at(-1) === 0) {
    row.pop();
  }
  return row;
};

const encodeCues = (brawlers: readonly RowSource[]): number[][] => {
  const cues: number[][] = [];
  for (const [i, b] of brawlers.entries()) {
    const { evasion, leap, meleeCue, rangedCue } = b;
    if (leap) {
      cues.push([
        i,
        CUE_LEAP,
        scaled(leap.t, MS),
        scaled(leap.sx, POS),
        scaled(leap.sz, POS),
        scaled(leap.tx, POS),
        scaled(leap.tz, POS),
      ]);
    }
    if (evasion) {
      cues.push([i, CUE_ROLL, scaled(evasion.angle, ANGLE), scaled(evasion.elapsed, MS)]);
    }
    if (meleeCue) {
      cues.push([
        i,
        CUE_SWING,
        scaled(meleeCue.angle, ANGLE),
        scaled(meleeCue.elapsed, MS),
        scaled(meleeCue.windup, MS),
        scaled(meleeCue.recovery, MS),
      ]);
    }
    if (rangedCue) {
      cues.push([i, CUE_SHOT, scaled(rangedCue.elapsed, MS), rangedCue.isSuper ? 1 : 0]);
    }
  }
  return cues;
};

const phaseIndex = (state: string): number => {
  if (state === "countdown") {
    return 0;
  }
  return state === "ended" ? 2 : 1;
};

/** One tick of the brawl. `t` is the host's wall clock, `simMs` its sim clock (for intent ages). */
export const encodeFrame = (
  source: FrameSource,
  seq: number,
  rosterVersion: number,
  t: number,
  simMs: number,
): NetFrame => {
  const p = phaseIndex(source.state);
  return {
    b: source.brawlers.map((b) => encodeRow(b, simMs)),
    c: scaled(p === 0 ? source.countdownT : source.matchTime, UNIT),
    g: source.generation,
    p,
    q: encodeCues(source.brawlers),
    s: seq,
    t: Math.round(t),
    v: rosterVersion,
  };
};

export const encodeMatch = (
  brawlers: readonly IdentitySource[],
  gen: number,
  seed: number,
  winner: string | null,
  rosterVersion: number,
): NetMatch => ({
  b: brawlers.map((b) => [b.netId, b.owner, b.def.id, b.name, scaled(b.hueShift, HUE)]),
  g: gen,
  seed,
  v: rosterVersion,
  w: winner,
});

/** Live boxes as flat `[spotIndex, hp, …]` pairs. */
export const encodeBoxes = (
  spots: readonly (readonly [number, number])[],
  boxes: readonly { alive: boolean; hp: number; tx: number; ty: number }[],
): number[] => {
  const out: number[] = [];
  for (const box of boxes) {
    if (!box.alive) {
      continue;
    }
    const i = spots.findIndex(([tx, ty]) => tx === box.tx && ty === box.ty);
    if (i !== -1) {
      out.push(i, Math.max(0, Math.round(box.hp)));
    }
  }
  return out;
};

/** Resting cubes as flat `[x, z, …]` pairs in centimetres. */
export const encodeCubes = (
  cubes: readonly { alive: boolean; x: number; z: number }[],
): number[] => {
  const out: number[] = [];
  for (const cube of cubes) {
    if (cube.alive) {
      out.push(scaled(cube.x, POS), scaled(cube.z, POS));
    }
  }
  return out;
};

// ── validation and decoding (guests, a promoted host) ──
// Field by field: a malformed room state must never reach the sim.

const isCount = (v: JsonValue | undefined): v is number =>
  isNum(v) && Number.isSafeInteger(v) && v >= 0;

const isInteger = (v: JsonValue | undefined): v is number => isNum(v) && Number.isSafeInteger(v);

const isNumbers = (v: JsonValue): v is number[] =>
  Array.isArray(v) && v.every((n) => isNum(n) && Number.isSafeInteger(n));

const isRow = (v: JsonValue): v is number[] => isNumbers(v) && v.length <= ROW_LENGTH;

const isCueRow = (v: JsonValue): v is number[] => isNumbers(v) && v.length >= 3 && v.length <= 7;

/** The wire frame's shape; rows are decoded against the roster by `decodeFrame`. */
export const parseFrame = (v: JsonValue | undefined): NetFrame | null => {
  if (!isObj(v)) {
    return null;
  }
  const { b, c, g, p, q, s, t } = v;
  const rosterVersion = v["v"];
  if (
    !isNum(t) ||
    !isCount(s) ||
    !isCount(g) ||
    !isCount(rosterVersion) ||
    !isCount(p) ||
    p >= PHASES.length ||
    !isInteger(c) ||
    !Array.isArray(b) ||
    b.length > MAX_ROSTER ||
    !b.every((row) => isRow(row)) ||
    !Array.isArray(q) ||
    q.length > MAX_ROSTER * 4 ||
    !q.every((cue) => isCueRow(cue))
  ) {
    return null;
  }
  return { b, c, g, p, q, s, t, v: rosterVersion };
};

const parseIdentity = (v: JsonValue): Identity | null => {
  if (!Array.isArray(v) || v.length !== 5) {
    return null;
  }
  const [id, owner, kit, name, hue] = v;
  if (
    !isStr(id) ||
    id.length > 64 ||
    !(owner === null || isStr(owner)) ||
    !isStr(kit) ||
    !isBrawlerId(kit) ||
    !isStr(name) ||
    !isNum(hue)
  ) {
    return null;
  }
  return { hue: hue / HUE, id, kit, name: name.slice(0, MAX_NAME), owner };
};

export const parseMatch = (v: JsonValue | undefined): MatchState | null => {
  if (!isObj(v)) {
    return null;
  }
  const { b, g, seed, w } = v;
  const rosterVersion = v["v"];
  if (
    !isCount(g) ||
    !isInteger(seed) ||
    !(w === null || isStr(w)) ||
    !isCount(rosterVersion) ||
    !Array.isArray(b) ||
    b.length > MAX_ROSTER
  ) {
    return null;
  }
  const roster: Identity[] = [];
  for (const item of b) {
    const identity = parseIdentity(item);
    if (!identity) {
      return null;
    }
    roster.push(identity);
  }
  return { gen: g, roster, rosterVersion, seed, winner: w };
};

const slot = (row: readonly number[], i: number): number => row[i] ?? 0;

/** Flags are powers of two; read one without bitwise operators. */
const hasFlag = (flags: number, flag: number): boolean => Math.floor(flags / flag) % 2 === 1;

const decodeRow = (row: readonly number[]): BrawlerState | null => {
  const x = slot(row, X) / POS;
  const z = slot(row, Z) / POS;
  const ammo = slot(row, AMMO) / UNIT;
  const charge = slot(row, CHARGE) / UNIT;
  const evadeCooldown = slot(row, EVADE_CD) / UNIT;
  const knockX = slot(row, KNOCK_X) / KNOCK;
  const knockZ = slot(row, KNOCK_Z) / KNOCK;
  if (
    Math.abs(x) > MAX_COORD ||
    Math.abs(z) > MAX_COORD ||
    slot(row, HP) < 0 ||
    ammo < 0 ||
    ammo > 3 ||
    charge < 0 ||
    charge > 1 ||
    evadeCooldown < 0 ||
    evadeCooldown > EVADE.cooldown + 0.01 ||
    slot(row, ACK) < 0 ||
    slot(row, ACK_AGE) < 0 ||
    slot(row, KNOCK_SEQ) < 0 ||
    Math.hypot(knockX, knockZ) > MAX_KNOCK
  ) {
    return null;
  }
  const flags = slot(row, FLAGS);
  return {
    ack: slot(row, ACK),
    ackAge: slot(row, ACK_AGE),
    alive: hasFlag(flags, ALIVE),
    ammo: Math.floor(ammo),
    charge,
    concealed: hasFlag(flags, CONCEALED),
    cubes: Math.max(0, slot(row, CUBES)),
    evade: slot(row, EVADE_RESULT),
    evadeCooldown,
    evasion: null,
    facing: slot(row, FACING) / ANGLE,
    hp: slot(row, HP),
    kills: Math.max(0, slot(row, KILLS)),
    knockSeq: slot(row, KNOCK_SEQ),
    knockX,
    knockZ,
    leap: null,
    melee: null,
    ranged: null,
    rank: Math.max(0, slot(row, RANK)),
    reload: ammo - Math.floor(ammo),
    x,
    z,
  };
};

const inArena = (...coords: number[]): boolean => coords.every((n) => Math.abs(n) <= MAX_COORD);
const isAngle = (angle: number): boolean => Math.abs(angle) <= Math.PI + 0.01;

const readLeap = (kit: BrawlerId, cue: readonly number[]): LeapArc | null => {
  const leap = {
    sx: slot(cue, 3) / POS,
    sz: slot(cue, 4) / POS,
    t: slot(cue, 2) / MS,
    tx: slot(cue, 5) / POS,
    tz: slot(cue, 6) / POS,
  };
  const { super: special } = BRAWLERS[kit];
  const valid =
    special.kind === "leap" &&
    leap.t >= 0 &&
    leap.t <= special.flight + 1 &&
    inArena(leap.sx, leap.sz, leap.tx, leap.tz);
  return valid ? leap : null;
};

const readRoll = (cue: readonly number[]): EvasionState | null => {
  const evasion = { angle: slot(cue, 2) / ANGLE, elapsed: slot(cue, 3) / MS };
  const valid =
    isAngle(evasion.angle) && evasion.elapsed >= 0 && evasion.elapsed <= EVADE.duration + 0.002;
  return valid ? evasion : null;
};

const readSwing = (kit: BrawlerId, cue: readonly number[]): MeleeCue | null => {
  const melee = {
    angle: slot(cue, 2) / ANGLE,
    elapsed: slot(cue, 3) / MS,
    recovery: slot(cue, 5) / MS,
    windup: slot(cue, 4) / MS,
  };
  const valid =
    BRAWLERS[kit].attack.kind === "melee" &&
    isAngle(melee.angle) &&
    melee.windup > 0 &&
    melee.windup <= 2 &&
    melee.recovery >= 0 &&
    melee.recovery <= 2 &&
    melee.elapsed >= 0 &&
    melee.elapsed <= melee.windup + melee.recovery + 0.002;
  return valid ? melee : null;
};

const readShot = (kit: BrawlerId, cue: readonly number[]): RangedCue | null => {
  const ranged = { elapsed: slot(cue, 2) / MS, isSuper: slot(cue, 3) === 1 };
  const def = BRAWLERS[kit];
  const { kind } = ranged.isSuper ? def.super : def.attack;
  const valid =
    (kind === "burst" || kind === "spread" || kind === "lob") &&
    ranged.elapsed >= 0 &&
    ranged.elapsed <= rangedPoseDuration(kit, ranged.isSuper) + 0.002;
  return valid ? ranged : null;
};

/** Fold one cue into its brawler, or false when it cannot belong there. */
const applyCue = (state: BrawlerState, kit: BrawlerId, cue: readonly number[]): boolean => {
  switch (slot(cue, 1)) {
    case CUE_LEAP: {
      state.leap = readLeap(kit, cue);
      return state.leap !== null;
    }
    case CUE_ROLL: {
      state.evasion = readRoll(cue);
      return state.evasion !== null;
    }
    case CUE_SWING: {
      state.melee = readSwing(kit, cue);
      return state.melee !== null;
    }
    case CUE_SHOT: {
      state.ranged = readShot(kit, cue);
      return state.ranged !== null;
    }
    default: {
      return false;
    }
  }
};

/** A pose the host can never hold together (a roll in mid-leap, a shot while dead). */
const isCoherent = (state: BrawlerState): boolean =>
  (state.evasion === null || (state.alive && state.leap === null)) &&
  (state.ranged === null ||
    (state.alive && state.evasion === null && state.leap === null && state.melee === null));

/** Decode a frame against the roster it was written for; null when they do not belong together. */
export const decodeFrame = (frame: NetFrame, match: MatchState): FrameState | null => {
  if (
    frame.g !== match.gen ||
    frame.v !== match.rosterVersion ||
    frame.b.length !== match.roster.length
  ) {
    return null;
  }
  const brawlers: BrawlerState[] = [];
  for (const row of frame.b) {
    const state = decodeRow(row);
    if (!state) {
      return null;
    }
    brawlers.push(state);
  }
  for (const cue of frame.q) {
    const state = brawlers[slot(cue, 0)];
    const identity = match.roster[slot(cue, 0)];
    if (!state || !identity || !applyCue(state, identity.kit, cue)) {
      return null;
    }
  }
  if (!brawlers.every((state) => isCoherent(state))) {
    return null;
  }
  return {
    brawlers,
    clock: frame.c / UNIT,
    gen: frame.g,
    phase: PHASES[frame.p] ?? "playing",
    rosterVersion: frame.v,
    seq: frame.s,
    t: frame.t,
  };
};

export const parseBoxes = (v: JsonValue | undefined): BoxState[] | null => {
  if (!Array.isArray(v) || !isNumbers(v) || v.length % 2 !== 0) {
    return null;
  }
  const boxes: BoxState[] = [];
  for (let k = 0; k < v.length; k += 2) {
    const i = slot(v, k);
    const hp = slot(v, k + 1);
    if (i < 0 || hp < 0) {
      return null;
    }
    boxes.push({ hp, i });
  }
  return boxes;
};

export const parseCubes = (v: JsonValue | undefined): CubeSpot[] | null => {
  if (!Array.isArray(v) || !isNumbers(v) || v.length % 2 !== 0) {
    return null;
  }
  const cubes: CubeSpot[] = [];
  for (let k = 0; k < v.length; k += 2) {
    const x = slot(v, k) / POS;
    const z = slot(v, k + 1) / POS;
    if (!inArena(x, z)) {
      return null;
    }
    cubes.push({ x, z });
  }
  return cubes;
};

export const parseBroken = (v: JsonValue | undefined): number[] | null =>
  Array.isArray(v) && isNumbers(v) && v.every((i) => i >= 0) ? v : null;

/** The room's shared state as one adoptable world, or null when any part is missing or malformed. */
export const assembleWorld = (state: JsonObject): WorldState | null => {
  const match = parseMatch(state["m"]);
  const wire = parseFrame(state["f"]);
  const frame = match && wire ? decodeFrame(wire, match) : null;
  const boxes = parseBoxes(state["bx"] ?? []);
  const cubes = parseCubes(state["cu"] ?? []);
  const broken = parseBroken(state["br"] ?? []);
  if (!match || !frame || !boxes || !cubes || !broken) {
    return null;
  }
  return { boxes, broken, cubes, frame, match };
};
