import type { Solid } from "../src/shared/types.ts";
import { RoadNetwork } from "../src/world/network.ts";
import { SolidIndex } from "../src/world/solid-index.ts";
import { districtAt } from "../src/world/sf-map.ts";
import {
  choosePlayerSpawn,
  isPlayerSpawnSafe,
  spawnOnEdge,
  type PlayerSpawn,
  type SpawnWorld,
} from "../src/world/player-spawn.ts";

type Check = (name: string, passed: boolean, detail?: string) => void;
const FAILED_SAFARI_SPAWN: PlayerSpawn = {
  x: 624.288,
  z: 309.164,
  yaw: -0.15595,
  gx: 170,
  gz: 123,
};

export function checkPlayerSpawnFixtures(check: Check): void {
  const network = new RoadNetwork(
    [
      [-1000, -200],
      [-1000, 200],
      [-1100, -200],
      [-1100, 200],
    ],
    [
      { a: 0, b: 1, w: 6, p: [-1000, -200, -1000, 200] },
      { a: 2, b: 3, w: 6, p: [-1100, -200, -1100, 200] },
    ],
  );
  const edge = network.edges[0];
  if (!edge) throw new Error("Missing spawn fixture edge");
  const spawn = spawnOnEdge(network, edge, 0.5, 1);
  const flat: SpawnWorld = { network, solids: new SolidIndex([]), decks: [], heightAt: () => 1 };
  const withSolids = (solids: readonly Solid[]): SpawnWorld => ({
    ...flat,
    solids: new SolidIndex(solids),
  });
  check("clear street permits a player start", isPlayerSpawnSafe(flat, spawn));
  check(
    "initial loading pose is revalidated against complete static solids",
    !isPlayerSpawnSafe(withSolids([{ minX: -1001, maxX: -999, minZ: 38, maxZ: 40 }]), spawn),
  );
  check(
    "swept opening route catches a thin no-body tree between sample points",
    !isPlayerSpawnSafe(
      withSolids([{ minX: -998.5, maxX: -998.4, minZ: 39.9, maxZ: 40.1, noBody: true }]),
      spawn,
    ),
  );
  check(
    "rotated obstacle corners cannot intrude into the spawn corridor",
    !isPlayerSpawnSafe(
      withSolids([{ minX: -997.5, maxX: -997, minZ: 30, maxZ: 40, yaw: Math.PI / 4 }]),
      spawn,
    ),
  );
  check(
    "spawn camera approach is clear behind the taxi",
    !isPlayerSpawnSafe(withSolids([{ minX: -1001, maxX: -999, minZ: -30, maxZ: -29 }]), spawn),
  );
  check(
    "street starts exclude elevated deck crossings",
    !isPlayerSpawnSafe(
      { ...flat, decks: [{ minX: -1008, maxX: -992, minZ: 45, maxZ: 55, y: 20 }] },
      spawn,
    ),
  );
  const underpass = FAILED_SAFARI_SPAWN;
  const fx = Math.sin(underpass.yaw);
  const fz = Math.cos(underpass.yaw);
  const behind: [number, number] = [underpass.x - fx * 150, underpass.z - fz * 150];
  const ahead: [number, number] = [underpass.x + fx * 150, underpass.z + fz * 150];
  const underpassRoad = new RoadNetwork(
    [behind, ahead],
    [{ a: 0, b: 1, w: 6, p: [...behind, ...ahead] }],
  );
  check(
    "freeway structure rejects a flat, straight route with no indexed obstacles",
    !isPlayerSpawnSafe({ ...flat, network: underpassRoad }, underpass),
  );
  check(
    "steep opening grades and lateral surface steps are rejected",
    !isPlayerSpawnSafe({ ...flat, heightAt: (_x, z) => 100 + z * 0.4 }, spawn) &&
      !isPlayerSpawnSafe({ ...flat, heightAt: (x) => (x > -999 ? 2 : 1) }, spawn),
  );
  check(
    "spawn center itself has valid surface support",
    !isPlayerSpawnSafe({ ...flat, heightAt: (_x, z) => (Math.abs(z) < 0.25 ? -1 : 1) }, spawn),
  );
  const deadEnd = new RoadNetwork(
    [
      [-1000, -100],
      [-1000, 40],
    ],
    [{ a: 0, b: 1, w: 6, p: [-1000, -100, -1000, 40] }],
  );
  check(
    "short roads do not promise an unsupported straight opening route",
    !isPlayerSpawnSafe({ ...flat, network: deadEnd }, spawn),
  );
  const firstBlocked = withSolids([{ minX: -1005, maxX: -995, minZ: -200, maxZ: 200 }]);
  const fallback = choosePlayerSpawn(firstBlocked, () => 0);
  check(
    "deterministic fallback validates a different street",
    fallback !== null && fallback.x === -1100 && isPlayerSpawnSafe(firstBlocked, fallback),
  );
  const blocked = withSolids([{ minX: -1200, maxX: -900, minZ: -300, maxZ: 300 }]);
  check(
    "no available route returns failure instead of an unchecked grid spawn",
    choosePlayerSpawn(blocked, () => 0) === null,
  );
}

export function checkInstalledPlayerSpawns(check: Check, world: SpawnWorld): void {
  check(
    "installed Silver Terrace trapped start is rejected",
    !isPlayerSpawnSafe(world, FAILED_SAFARI_SPAWN),
  );
  const districts = new Set<string>();
  const origins = new Set<string>();
  let viable = 0;
  let seed = 0x5f504157;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let worstMs = 0;
  const timings: number[] = [];
  for (let i = 0; i < 64; i++) {
    const start = performance.now();
    const spawn = choosePlayerSpawn(world, random);
    const elapsed = performance.now() - start;
    timings.push(elapsed);
    worstMs = Math.max(worstMs, elapsed);
    if (!spawn || !isPlayerSpawnSafe(world, spawn)) continue;
    viable++;
    origins.add(`${spawn.x.toFixed(1)},${spawn.z.toFixed(1)}`);
    districts.add(districtAt(spawn.gx, spawn.gz).name);
  }
  timings.sort((a, b) => a - b);
  check(
    "installed world supports repeated safe starts",
    viable === 64,
    `${viable}/64; median ${timings[32]?.toFixed(1)}ms, p95 ${timings[60]?.toFixed(1)}ms, worst ${worstMs.toFixed(1)}ms`,
  );
  check(
    "safe starts retain neighborhood variety",
    districts.size >= 8 && origins.size >= 48,
    `${districts.size} districts, ${origins.size} origins: ${[...districts].sort().join(", ")}`,
  );
  let safeMidpoints = 0;
  const midpointDistricts = new Set<string>();
  for (const edge of world.network.edges) {
    if (edge.len < 30) continue;
    for (const direction of [-1, 1] satisfies readonly (1 | -1)[]) {
      const candidate = spawnOnEdge(world.network, edge, 0.5, direction);
      if (!isPlayerSpawnSafe(world, candidate)) continue;
      safeMidpoints++;
      midpointDistricts.add(districtAt(candidate.gx, candidate.gz).name);
    }
  }
  check(
    "validated deterministic search has broad installed-world coverage",
    safeMidpoints >= 100 && midpointDistricts.size >= 12,
    `${safeMidpoints} directed starts across ${midpointDistricts.size} districts`,
  );
}
