import { GRID_X, GRID_Z, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import type { Solid, SurfaceDeck } from "../shared/types";
import { nearFreeway } from "./freeways";
import type { NetEdge, RoadNetwork } from "./network";
import type { SolidIndex } from "./solid-index";

export type PlayerSpawn = {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly gx: number;
  readonly gz: number;
};

export type SpawnWorld = {
  readonly network: RoadNetwork;
  readonly solids: SolidIndex;
  readonly decks: readonly SurfaceDeck[];
  readonly heightAt: (x: number, z: number) => number;
};

const FORWARD = 80;
const REAR = 35;
const STEP = 2;
const CLEARANCE = 1.6; // car collision radius 1.05, plus room around its opening route
const MAX_GRADE = 0.18;
const MAX_CROSS_SLOPE = 0.3;
const OVERHEAD_MARGIN = 4;
const RANDOM_ATTEMPTS = 64;

/** A swept corridor, rather than isolated points, cannot skip a thin tree or wall. */
function corridorHitsSolid(spawn: PlayerSpawn, solid: Solid): boolean {
  const yaw = solid.yaw ?? 0;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const dx = spawn.x - (solid.minX + solid.maxX) / 2;
  const dz = spawn.z - (solid.minZ + solid.maxZ) / 2;
  const fx = Math.sin(spawn.yaw);
  const fz = Math.cos(spawn.yaw);
  const axes = [
    {
      origin: dx * c - dz * s,
      direction: fx * c - fz * s,
      half: (solid.maxX - solid.minX) / 2 + CLEARANCE,
    },
    {
      origin: dx * s + dz * c,
      direction: fx * s + fz * c,
      half: (solid.maxZ - solid.minZ) / 2 + CLEARANCE,
    },
  ];
  let enter = -REAR;
  let leave = FORWARD;
  for (const axis of axes) {
    if (Math.abs(axis.direction) < 1e-8) {
      if (Math.abs(axis.origin) > axis.half) return false;
      continue;
    }
    const a = (-axis.half - axis.origin) / axis.direction;
    const b = (axis.half - axis.origin) / axis.direction;
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
    if (enter > leave) return false;
  }
  return true;
}

/** Street starts need an open camera approach and several seconds of safe throttle. */
export function isPlayerSpawnSafe(world: SpawnWorld, spawn: PlayerSpawn): boolean {
  if (![spawn.x, spawn.z, spawn.yaw].every(Number.isFinite)) return false;
  const forwardX = Math.sin(spawn.yaw);
  const forwardZ = Math.cos(spawn.yaw);
  let previousHeight: number | null = null;
  let previousDistance = -REAR;
  // Anchor a sample at the taxi itself as well as both corridor endpoints.
  for (
    let distance = -REAR;
    distance <= FORWARD;
    distance = distance < 0 ? Math.min(0, distance + STEP) : distance + STEP
  ) {
    const x = spawn.x + forwardX * distance;
    const z = spawn.z + forwardZ * distance;
    if (Math.abs(x) > WORLD_HALF_X * 0.88 || Math.abs(z) > WORLD_HALF_Z * 0.88) return false;
    const road = world.network.nearest(x, z, 16);
    if (!road || road.dist + CLEARANCE > road.edge.half) return false;
    if (nearFreeway(x, z, OVERHEAD_MARGIN)) return false;
    if (
      world.decks.some(
        (deck) =>
          x >= deck.minX - OVERHEAD_MARGIN &&
          x <= deck.maxX + OVERHEAD_MARGIN &&
          z >= deck.minZ - OVERHEAD_MARGIN &&
          z <= deck.maxZ + OVERHEAD_MARGIN,
      )
    )
      return false;
    const height = world.heightAt(x, z);
    if (!Number.isFinite(height) || height < -0.1) return false;
    if (
      previousHeight !== null &&
      Math.abs(height - previousHeight) > (distance - previousDistance) * MAX_GRADE
    )
      return false;
    previousHeight = height;
    previousDistance = distance;
    for (const side of [-1, 1]) {
      const wheelHeight = world.heightAt(
        x + forwardZ * CLEARANCE * side,
        z - forwardX * CLEARANCE * side,
      );
      if (!Number.isFinite(wheelHeight) || Math.abs(wheelHeight - height) > MAX_CROSS_SLOPE)
        return false;
    }
  }
  const rearX = spawn.x - forwardX * REAR;
  const rearZ = spawn.z - forwardZ * REAR;
  const endX = spawn.x + forwardX * FORWARD;
  const endZ = spawn.z + forwardZ * FORWARD;
  let obstructed = false;
  world.solids.forEachIn(
    Math.min(rearX, endX) - CLEARANCE,
    Math.max(rearX, endX) + CLEARANCE,
    Math.min(rearZ, endZ) - CLEARANCE,
    Math.max(rearZ, endZ) + CLEARANCE,
    (solid) => {
      if (corridorHitsSolid(spawn, solid)) obstructed = true;
    },
  );
  return !obstructed;
}

/** Stable candidate enumeration also supports an installed-world availability audit. */
export function spawnOnEdge(
  network: RoadNetwork,
  edge: NetEdge,
  fraction: number,
  sign: 1 | -1,
): PlayerSpawn {
  const point = network.sample(edge, edge.len * fraction);
  return {
    x: point.x,
    z: point.z,
    yaw: Math.atan2(point.tx * sign, point.tz * sign),
    gx: Math.floor((point.x + WORLD_HALF_X) / ROAD_TILE),
    gz: Math.floor((point.z + WORLD_HALF_Z) / ROAD_TILE),
  };
}

/** A bounded random search keeps district variety; the fallback is validated too. */
export function choosePlayerSpawn(
  world: SpawnWorld,
  random: () => number = Math.random,
): PlayerSpawn | null {
  const edges = world.network.edges.filter((edge) => edge.len >= 30);
  for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt++) {
    const edge = edges[Math.floor(random() * edges.length)];
    if (!edge) continue;
    const candidate = spawnOnEdge(
      world.network,
      edge,
      0.25 + random() * 0.5,
      random() < 0.5 ? -1 : 1,
    );
    if (isPlayerSpawnSafe(world, candidate)) return candidate;
  }
  for (const edge of edges) {
    for (const fraction of [0.5, 0.25, 0.75]) {
      for (const sign of [-1, 1] satisfies readonly (1 | -1)[]) {
        const candidate = spawnOnEdge(world.network, edge, fraction, sign);
        if (
          candidate.gx < 0 ||
          candidate.gz < 0 ||
          candidate.gx >= GRID_X ||
          candidate.gz >= GRID_Z
        )
          continue;
        if (isPlayerSpawnSafe(world, candidate)) return candidate;
      }
    }
  }
  return null;
}
