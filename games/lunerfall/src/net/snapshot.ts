// Host ↔ guest wire format. Everything here is plain JSON.
//
// Host → guest, in shared state (patches shallow-merge per key):
//   snap        30 Hz on a steady clock, stamped with the room's server time as
//               it goes out: the moving parts as compact rows, plus the guest
//               body's input ack and the edges the host applied to it (hits,
//               bounces, downs, respawns)
//   cast        on change: who the rows are — player ids + heroes, enemy kinds
//   status      on change: hearts, gold, score, depth — numbers that move on
//               events, not every tick
//   room        on change: the layout, once per room
//   checkpoint  1 Hz and on phase/progress edges: everything a takeover needs,
//               stamped like the snapshot it rides with
// Guest → host, an event to the host alone:
//   in          the guest's input, one entry per 60 Hz sim tick, two per send
//
// A guest draws everyone else from the stamps, 100 ms of buffer behind the
// relay's own latency (net/interp.ts), and predicts its own body, replaying
// the host's edges into its history and reconciling against its row at the
// acked tick (net/predict.ts). Rows are tuples: a snapshot is a couple of
// dozen of them, thirty times a second.

import type { BossState } from "../entities/boss-body";
import type { EnemyState } from "../entities/enemy-body";
import type { BodyEdge } from "../entities/player-body";

/** Bump on any incompatible change to this file's formats: it is part of the
 * party room id, so a tab on an older build never shares a run with a newer one. */
export const WIRE_VERSION = 3;

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

// Flags travel as sums of powers of two, read back with integer division.
const flag = (bits: number, bit: number): boolean => Math.floor(bits / bit) % 2 === 1;
const bit = (on: boolean, value: number): number => (on ? value : 0);
const tenth = (v: number): number => Math.round(v * 10) / 10;
const centis = (seconds: number): number => Math.round(seconds * 100);

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
  // co-op last stand: frozen awaiting a revive
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

export const encodePlayer = (p: PlayerPose): NetPlayerRow => [
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

export const decodePlayer = (row: NetPlayerRow): PlayerPose => {
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

// Enemies/boss travel as their FSM state + its age so the guest replays the
// exact pose the host shows (data/actor-presentation.ts) — no clip strings.
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

export const encodeEnemy = (id: number, e: EnemyPose): NetEnemyRow => [
  id,
  Math.round(e.x),
  Math.round(e.y),
  Math.max(0, ENEMY_STATES.indexOf(e.state)),
  centis(e.elapsed),
  bit(e.flip, 1) + bit(e.flash, 2) + bit(e.moving, 4),
];

export const decodeEnemy = (row: NetEnemyRow): EnemyPose => {
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

export const encodeBoss = (b: BossPose): NetBossRow => [
  Math.round(b.x),
  Math.round(b.y),
  Math.max(0, BOSS_STATES.indexOf(b.state)),
  centis(b.elapsed),
  bit(b.flip, 1) + bit(b.flash, 2) + bit(b.telegraph, 4) + bit(b.moving, 8),
  Math.round(b.hpFrac * 1000),
];

export const decodeBoss = (row: NetBossRow): BossPose => {
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

// Projectiles blend between rows like any puppet; ids are stable for the
// projectile's life.
export type NetProjRow = [id: number, kind: number, x: number, y: number, vx: number, vy: number];

// One host-applied edge on a guest body: `n` orders them, `tick` is the
// guest input tick after which the host applied it; `a`/`b` are its argument
// (hurt: knockback direction; spawn: the point).
export type NetEdge = [n: number, tick: number, kind: number, a: number, b: number];

/** A decoded edge; a null `edge` is a versus freeze (inputs after `tick` were neutralised). */
export interface GuestEdge {
  n: number;
  tick: number;
  edge: BodyEdge | null;
}

export const encodeEdge = (n: number, tick: number, edge: BodyEdge | null): NetEdge => {
  if (!edge) {
    return [n, tick, EDGE_KINDS.indexOf("freeze"), 0, 0];
  }
  const code = EDGE_KINDS.indexOf(edge.kind);
  if (edge.kind === "hurt") {
    return [n, tick, code, edge.dir, 0];
  }
  return edge.kind === "spawn" ? [n, tick, code, edge.x, edge.y] : [n, tick, code, 0, 0];
};

const edgeOf = (kind: EdgeKind, a: number, b: number): BodyEdge | null => {
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
    default: {
      return { kind };
    }
  }
};

export const decodeEdge = (row: NetEdge): GuestEdge | null => {
  const [n, tick, code, a, b] = row;
  const kind = EDGE_KINDS[code];
  return kind ? { edge: edgeOf(kind, a, b), n, tick } : null;
};

// Per guest body: the newest input tick its copy applied, how many host steps
// it has coasted past it (input starved), and the edges of the last ~2 s.
export type NetAck = {
  row: number;
  ack: number;
  age: number;
  edges: NetEdge[];
};

// Co-op last stand: broadcast while a player is downed. bleed = seconds left on
// the bleed-out clock; rev = 0..1 revive-hold progress. Which player is downed
// travels on its row; both clients render the marker from these.
export type NetLastStand = {
  bleed: number;
  rev: number;
};

// Online versus: the match state, broadcast every snapshot while in versus mode.
// Sides are fixed (host = left duelist, guest = right) so hearts/scores never
// need a player-id mapping on either client.
export type NetVersus = {
  phase: "waiting" | "countdown" | "fighting" | "roundEnd" | "matchEnd";
  // 1-based; 0 while waiting for the challenger
  round: number;
  // seconds left in the current timed phase
  t: number;
  hostHp: number;
  guestHp: number;
  hostScore: number;
  guestScore: number;
  // round winner in roundEnd, match in matchEnd
  winner: "host" | "guest" | null;
};

export type Snapshot = {
  // server time (ms) the host sent it: every client's timebase, so stamps run
  // on through hit-stop and across a host change
  t: number;
  // runTag of the run id + authority term: a snapshot from an older run or
  // host is never applied
  run: number;
  term: number;
  // room seq; the guest rebuilds its room when this moves on
  room: number;
  // same order as cast.players
  players: NetPlayerRow[];
  acks: NetAck[];
  enemies: NetEnemyRow[];
  boss: NetBossRow | null;
  proj: NetProjRow[];
  lastStand: NetLastStand | null;
  // versus mode only; null in co-op
  vs: NetVersus | null;
};

// The run's HUD and progress, sent only when it changes.
export type NetStatus = {
  hearts: number;
  maxHearts: number;
  gold: number;
  score: number;
  biome: number;
  depth: number;
  // the room's doors are open
  cleared: boolean;
  // the shared run ended (co-op death)
  over: boolean;
};

// Static per-entity data, sent only when it changes.
export type NetCast = {
  players: [id: string, hero: string][];
  enemies: [id: number, name: string, tint: number][];
};

// Guest → host: input ticks `seq - ticks.length + 1 … seq`, each a packed
// BodyInput (net/uplink.ts), all generated in room `room`.
export type NetInputs = {
  seq: number;
  ticks: number[];
  room: number;
};

// Full room layout — sent once per room (not per frame).
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
  // "coop" | "vs" — versus arenas mirror the guest spawn, no doors
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
export const runTag = (runId: string): number => {
  let h = 0;
  for (const ch of runId) {
    h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return h;
};
