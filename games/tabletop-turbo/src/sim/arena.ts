/** A piece of board (or a hole cut in it), seen from above. */
export type Slab =
  | { kind: "box"; x: number; z: number; hx: number; hz: number; round: number }
  | { kind: "disc"; x: number; z: number; r: number };

export interface Spawn {
  x: number;
  z: number;
  /** Heading a car drops in with. */
  a: number;
}

export type HazardDef =
  | { kind: "bumper"; x: number; z: number; r: number }
  | {
      kind: "sweeper";
      x: number;
      z: number;
      /** Pivot to tip. */
      length: number;
      /** Radians per second; the sign is the way it turns. */
      rate: number;
      phase: number;
    }
  | {
      kind: "piston";
      x: number;
      z: number;
      /** The way it fires. */
      a: number;
      /** How far the head travels. */
      reach: number;
      /** Seconds between shots, and this piston's offset into that cycle. */
      period: number;
      phase: number;
    };

export interface ArenaDef {
  id: string;
  name: string;
  /** The board is the union of these, less the holes. */
  solids: readonly Slab[];
  /** What is left of the board once the ends have dropped away. */
  core: readonly Slab[];
  holes: readonly Slab[];
  /** Where the round starts, one per car. */
  grid: readonly Spawn[];
  /** Where a car drops back in: all on the core. */
  spawns: readonly Spawn[];
  /** Where crates land: knocker mods on the first list, car mods on the second. */
  knockerPads: readonly (readonly [number, number])[];
  carPads: readonly (readonly [number, number])[];
  hazards: readonly HazardDef[];
}

export interface Arena {
  def: ArenaDef;
  /** Half extents of the box that holds every solid. */
  halfX: number;
  halfZ: number;
}

const inside = (slab: Slab, x: number, z: number) => {
  if (slab.kind === "disc") {
    return slab.r - Math.hypot(x - slab.x, z - slab.z);
  }

  const qx = Math.abs(x - slab.x) - (slab.hx - slab.round);
  const qz = Math.abs(z - slab.z) - (slab.hz - slab.round);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);

  return slab.round - outside;
};

/**
 * Distance from (x, z) to the nearest edge of the board: positive on it,
 * negative off it. `late` is the board after its ends have dropped. Exact near
 * a single edge, a fair estimate where shapes meet.
 */
export const edgeDistance = (arena: Arena, x: number, z: number, late = false) => {
  let d = Number.NEGATIVE_INFINITY;

  for (const solid of late ? arena.def.core : arena.def.solids) {
    d = Math.max(d, inside(solid, x, z));
  }

  for (const hole of arena.def.holes) {
    d = Math.min(d, -inside(hole, x, z));
  }

  return d;
};

/** Distance from (x, z) to the nearest hole's edge: positive outside every hole. */
export const holeDistance = (arena: Arena, x: number, z: number) => {
  let d = Number.POSITIVE_INFINITY;

  for (const hole of arena.def.holes) {
    d = Math.min(d, -inside(hole, x, z));
  }

  return d;
};

export const onBoard = (arena: Arena, x: number, z: number, late = false) =>
  edgeDistance(arena, x, z, late) > 0;

const PROBE = 0.35;

/** Unit vector at (x, z) pointing away from the nearest edge, towards more board. */
export const inward = (arena: Arena, x: number, z: number, late = false) => {
  const gx = edgeDistance(arena, x + PROBE, z, late) - edgeDistance(arena, x - PROBE, z, late);
  const gz = edgeDistance(arena, x, z + PROBE, late) - edgeDistance(arena, x, z - PROBE, late);
  const length = Math.hypot(gx, gz);

  return length > 1e-6 ? { x: gx / length, z: gz / length } : { x: 0, z: 0 };
};

const extent = (slab: Slab) =>
  slab.kind === "disc"
    ? { x: Math.abs(slab.x) + slab.r, z: Math.abs(slab.z) + slab.r }
    : { x: Math.abs(slab.x) + slab.hx, z: Math.abs(slab.z) + slab.hz };

export const buildArena = (def: ArenaDef) => {
  let halfX = 1;
  let halfZ = 1;

  for (const solid of def.solids) {
    const reach = extent(solid);
    halfX = Math.max(halfX, reach.x);
    halfZ = Math.max(halfZ, reach.z);
  }

  return { def, halfX, halfZ } satisfies Arena;
};

const box = (x: number, z: number, hx: number, hz: number, round: number) =>
  ({ hx, hz, kind: "box", round, x, z }) satisfies Slab;

const facing = (x: number, z: number) => ({ a: Math.atan2(-z, -x), x, z }) satisfies Spawn;

/** One car length: the unit the boards are laid out in. */
export const CL = 2.4;

const INNER = [
  facing(-3 * CL, -3.5 * CL),
  facing(3 * CL, 3.5 * CL),
  facing(3 * CL, -3.5 * CL),
  facing(-3 * CL, 3.5 * CL),
];

/**
 * The boards, in rotation. Each is a sheet of card on a table with holes cut
 * in it; its two ends drop away for the last stretch of a round.
 */
export const ARENAS: readonly ArenaDef[] = [
  {
    carPads: [
      [-6 * CL, -4.25 * CL],
      [6 * CL, 4.25 * CL],
    ],
    core: [box(0, 0, 7.25 * CL, 6.5 * CL, 2.4)],
    grid: [
      ...INNER,
      facing(-9 * CL, -4 * CL),
      facing(9 * CL, 4 * CL),
      facing(9 * CL, -4 * CL),
      facing(-9 * CL, 4 * CL),
    ],
    hazards: [
      { kind: "sweeper", length: 2.5 * CL, phase: 0.6, rate: (Math.PI * 2) / 8, x: 0, z: 0 },
      { kind: "bumper", r: 1.5, x: -6 * CL, z: 4 * CL },
      { kind: "bumper", r: 1.5, x: 6 * CL, z: -4 * CL },
      {
        a: -Math.PI / 2,
        kind: "piston",
        period: 6,
        phase: 0,
        reach: 4 * CL,
        x: 6 * CL,
        z: 6.5 * CL + 1.2,
      },
      {
        a: Math.PI / 2,
        kind: "piston",
        period: 6,
        phase: 3,
        reach: 4 * CL,
        x: -6 * CL,
        z: -6.5 * CL - 1.2,
      },
    ],
    holes: [box(-6 * CL, 0, 1.25 * CL, 1.25 * CL, 0.7), box(6 * CL, 0, 1.25 * CL, 1.25 * CL, 0.7)],
    id: "pinball",
    knockerPads: [
      [-9.5 * CL, 0],
      [9.5 * CL, 0],
    ],
    name: "Pinball",
    solids: [box(0, 0, 11 * CL, 6.5 * CL, 4.8)],
    spawns: INNER,
  },
];

export const arenaFor = (index: number) => {
  const def = ARENAS[((index % ARENAS.length) + ARENAS.length) % ARENAS.length] ?? ARENAS[0];

  if (!def) {
    throw new Error("no arenas");
  }

  return buildArena(def);
};
