import type { BossState } from "../entities/boss-body";
import type { EnemyState } from "../entities/enemy-body";
import type { BodyEdge } from "../entities/player-body";

/** Bump on any incompatible change to this file's formats: it is part of the
 * party room id, so a tab on an older build never shares a run with a newer one. */
export const WIRE_VERSION = 4;

/** Wire order of the enemy FSM states; rows carry the index. */
export const ENEMY_STATES = [
  "spawn",
  "chase",
  "windup",
  "attack",
  "charge",
  "recover",
  "hurt",
  "dead",
] as const satisfies readonly EnemyState[];

export const BOSS_STATES = [
  "intro",
  "idle",
  "wave",
  "jump",
  "slam",
  "charge",
  "punch",
  "hurt",
  "phase",
  "dead",
] as const satisfies readonly BossState[];

export const PROJ_KINDS = ["arrow", "shot", "hazard"] as const;

export type ProjKind = (typeof PROJ_KINDS)[number];

/** Host-applied discontinuities on a guest's body, in wire order; `freeze` is
 * the host neutralising input the guest sent before it saw a versus freeze. */
export const EDGE_KINDS = ["hurt", "bounce", "down", "revive", "dead", "spawn", "freeze"] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

const flag = (bits: number, bit: number) => Math.floor(bits / bit) % 2 === 1;
const bit = (on: boolean, value: number) => (on ? value : 0);
const tenth = (v: number) => Math.round(v * 10) / 10;
const centis = (seconds: number) => Math.round(seconds * 100);

/** The body fields a player row carries — a PlayerBody satisfies it. */
export interface PlayerPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  grounded: boolean;
  dashing: boolean;
  hurting: boolean;
  dead: boolean;
  downed: boolean;
  specialActive: boolean;
  iframes: number;
  attackStep: number;
  swingId: number;
  specialId: number;
}

export type NetPlayerRow = [
  x: number,
  y: number,
  vx: number,
  vy: number,
  flags: number,
  iframes: number,
  attackStep: number,
  swingId: number,
  specialId: number,
];

export const encodePlayer: (p: PlayerPose) => NetPlayerRow = (p) => [
  tenth(p.x),
  tenth(p.y),
  Math.round(p.vx),
  Math.round(p.vy),
  bit(p.facing < 0, 1) +
    bit(p.grounded, 2) +
    bit(p.dashing, 4) +
    bit(p.hurting, 8) +
    bit(p.dead, 16) +
    bit(p.downed, 32) +
    bit(p.specialActive, 64),
  centis(p.iframes),
  p.attackStep,
  p.swingId,
  p.specialId,
];

export const decodePlayer: (row: NetPlayerRow) => PlayerPose = (row) => {
  const [x, y, vx, vy, flags, iframes, attackStep, swingId, specialId] = row;

  return {
    attackStep,
    dashing: flag(flags, 4),
    dead: flag(flags, 16),
    downed: flag(flags, 32),
    facing: flag(flags, 1) ? -1 : 1,
    grounded: flag(flags, 2),
    hurting: flag(flags, 8),
    iframes: iframes / 100,
    specialActive: flag(flags, 64),
    specialId,
    swingId,
    vx,
    vy,
    x,
    y,
  };
};

export interface EnemyPose {
  x: number;
  y: number;
  state: EnemyState;
  elapsed: number;
  flip: boolean;
  flash: boolean;
  moving: boolean;
}

export type NetEnemyRow = [
  id: number,
  x: number,
  y: number,
  state: number,
  elapsed: number,
  flags: number,
];

export const encodeEnemy: (id: number, e: EnemyPose) => NetEnemyRow = (id, e) => [
  id,
  Math.round(e.x),
  Math.round(e.y),
  Math.max(0, ENEMY_STATES.indexOf(e.state)),
  centis(e.elapsed),
  bit(e.flip, 1) + bit(e.flash, 2) + bit(e.moving, 4),
];

export const decodeEnemy = (row: NetEnemyRow) => {
  const [, x, y, state, elapsed, flags] = row;

  return {
    elapsed: elapsed / 100,
    flash: flag(flags, 2),
    flip: flag(flags, 1),
    moving: flag(flags, 4),
    state: ENEMY_STATES[state] ?? "chase",
    x,
    y,
  };
};

export interface BossPose {
  x: number;
  y: number;
  state: BossState;
  elapsed: number;
  flip: boolean;
  flash: boolean;
  telegraph: boolean;
  moving: boolean;
  hpFrac: number;
}

export type NetBossRow = [
  x: number,
  y: number,
  state: number,
  elapsed: number,
  flags: number,
  hp: number,
];

export const encodeBoss: (b: BossPose) => NetBossRow = (b) => [
  Math.round(b.x),
  Math.round(b.y),
  Math.max(0, BOSS_STATES.indexOf(b.state)),
  centis(b.elapsed),
  bit(b.flip, 1) + bit(b.flash, 2) + bit(b.telegraph, 4) + bit(b.moving, 8),
  Math.round(b.hpFrac * 1000),
];

export const decodeBoss = (row: NetBossRow) => {
  const [x, y, state, elapsed, flags, hp] = row;

  return {
    elapsed: elapsed / 100,
    flash: flag(flags, 2),
    flip: flag(flags, 1),
    hpFrac: hp / 1000,
    moving: flag(flags, 8),
    state: BOSS_STATES[state] ?? "idle",
    telegraph: flag(flags, 4),
    x,
    y,
  };
};

export type NetProjRow = [id: number, kind: number, x: number, y: number, vx: number, vy: number];

export type NetEdge = [n: number, tick: number, kind: number, a: number, b: number];

/** A decoded edge; a null `edge` is a versus freeze (inputs after `tick` were neutralised). */
export interface GuestEdge {
  n: number;
  tick: number;
  edge: BodyEdge | null;
}

export const encodeEdge: (n: number, tick: number, edge: BodyEdge | null) => NetEdge = (
  n,
  tick,
  edge,
) => {
  if (!edge) {
    return [n, tick, EDGE_KINDS.indexOf("freeze"), 0, 0];
  }

  const code = EDGE_KINDS.indexOf(edge.kind);

  if (edge.kind === "hurt") {
    return [n, tick, code, edge.dir, 0];
  }

  return edge.kind === "spawn" ? [n, tick, code, edge.x, edge.y] : [n, tick, code, 0, 0];
};

const edgeOf = (kind: EdgeKind, a: number, b: number) => {
  switch (kind) {
    case "hurt": {
      return { dir: a, kind };
    }

    case "spawn": {
      return { kind, x: a, y: b };
    }

    case "freeze": {
      return null;
    }

    case "bounce":
    case "dead":
    case "down":
    case "revive": {
      return { kind };
    }

    default: {
      const unhandled: never = kind;
      throw new Error("unhandled case", { cause: unhandled });
    }
  }
};

export const decodeEdge = (row: NetEdge) => {
  const [n, tick, code, a, b] = row;
  const kind = EDGE_KINDS[code];

  return kind ? { edge: edgeOf(kind, a, b), n, tick } : null;
};

export type NetAck = {
  row: number;
  ack: number;
  age: number;
  edges: NetEdge[];
};

export type NetLastStand = {
  bleed: number;
  rev: number;
};

export type NetVersus = {
  phase: "waiting" | "countdown" | "fighting" | "roundEnd" | "matchEnd";
  round: number;
  t: number;
  hostHp: number;
  guestHp: number;
  hostScore: number;
  guestScore: number;
  winner: "host" | "guest" | null;
};

export type Snapshot = {
  t: number;
  run: number;
  term: number;
  room: number;
  players: NetPlayerRow[];
  acks: NetAck[];
  enemies: NetEnemyRow[];
  boss: NetBossRow | null;
  proj: NetProjRow[];
  lastStand: NetLastStand | null;
  vs: NetVersus | null;
};

export type NetStatus = {
  hearts: number;
  maxHearts: number;
  gold: number;
  score: number;
  biome: number;
  depth: number;
  cleared: boolean;
  over: boolean;
};

export type NetCast = {
  players: [id: string, hero: string][];
  enemies: [id: number, name: string, tint: number][];
};

export type NetInputs = {
  seq: number;
  ticks: number[];
  room: number;
  t: number;
};

export type NetDoor = {
  index: number;
  x: number;
  y: number;
  type: string;
  label: string;
  danger: boolean;
};

export type NetRoom = {
  seq: number;
  mode: string;
  type: string;
  cols: number;
  rows: number;
  cells: number[];
  spawnX: number;
  spawnY: number;
  doors: NetDoor[];
  propKey: string;
  mustClear: boolean;
};

/** Snapshots name their run with this instead of the 50-character run id. */
export const runTag = (runId: string) => {
  let h = 0;

  for (const ch of runId) {
    h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 2_147_483_647;
  }

  return h;
};
