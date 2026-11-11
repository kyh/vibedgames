// Co-op protocol. One host simulates the machines and owns the run (relays,
// waves, barrels); guests send it intents and draw its world. Nothing here is
// backward compatible: a wire change bumps ROOM_PREFIX so old tabs never share
// a room with new ones.

export const PARTY = "vg-server";
export const LOBBY = "saltline";
export const ROOM_PREFIX = "saltline-v1-";
/** A breach unit is four. Overflow rooms take the fifth. */
export const MAX_PLAYERS = 4;
/** No room in this long (rendered frames): play solo. */
export const FALLBACK_MS = 6000;

/** Host world snapshot rate (enemy poses, run state, barrels). */
export const WORLD_HZ = 15;
/** Own-body send rate. */
export const BODY_HZ = 20;
/** Shared-state key the host writes the world under. */
export const WORLD_KEY = "world";

/** Events. Payloads are positional arrays to keep the wire small. */
export const EV = {
  /** guest → host: `[barrelIndex, damage, px, py, pz, dx, dy, dz]` */
  barrel: "barrel",
  /** host → guests: batched enemy cues, see `EnemyCue` */
  cues: "cues",
  /** guest → host: relay id */
  cut: "cut",
  /** guest → host: `[enemyNetId, damage, part, px, py, pz, dx, dy, dz]` */
  hit: "hit",
  /** host → one guest: `[damage, fx, fy, fz]` */
  hurt: "hurt",
  /** host → shooter: `enemyNetId` (the hit killed it) */
  kill: "kill",
  /** anyone → others: `[mx, my, mz, ex, ey, ez, weapon(0 rifle | 1 pistol)]` */
  shot: "shot",
  /** host → guests: a HUD warning string */
  warn: "warn",
} as const;

/** Enemy cue kinds the host batches to guests each world tick. */
export const CUE = { alert: 3, fire: 0, melee: 2, telegraph: 1 } as const;
export type CueKind = (typeof CUE)[keyof typeof CUE];

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
  /** where this player is: see `PHASE` */
  ph: number;
}

/** Where a player is in the game's flow. */
export const PHASE = { deployed: 1, down: 2, extracted: 3, menu: 0 } as const;

/** Build the room id from a squad code (`?room=`). */
export const roomId = (code: string): string =>
  ROOM_PREFIX +
  code
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "")
    .slice(0, 16);

/** Round for the wire: three decimals is a millimetre, or a milliradian. */
export const q3 = (v: number): number => Math.round(v * 1000) / 1000;
