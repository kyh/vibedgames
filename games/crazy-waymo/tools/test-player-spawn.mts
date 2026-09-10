import type { Solid } from "../src/shared/types.ts";
import { RoadNetwork } from "../src/world/network.ts";
import { SolidIndex } from "../src/world/solid-index.ts";
import { districtAt } from "../src/world/sf-map.ts";
import { choosePlayerSpawn, isPlayerSpawnSafe, spawnOnEdge } from "../src/world/player-spawn.ts";
import type { PlayerSpawn, SpawnWorld } from "../src/world/player-spawn.ts";

type Check = (name: string, passed: boolean, detail?: string) => void;
const FAILED_SAFARI_SPAWN: PlayerSpawn = {
  gx: 170,
  gz: 123,
  x: 624.288,
  yaw: -0.15595,
  z: 309.164,
};

export const checkPlayerSpawnFixtures = (check: Check): void => {
  const network = new RoadNetwork(
    [
      [-1000, -200],
      [-1000, 200],
      [-1100, -200],
      [-1100, 200],
    ],
    [
      { a: 0, b: 1, p: [-1000, -200, -1000, 200], w: 6 },
      { a: 2, b: 3, p: [-1100, -200, -1100, 200], w: 6 },
    ],
  );
  const [edge] = network.edges;
  if (!edge) {
    throw new Error("Missing spawn fixture edge");
  }
  const spawn = spawnOnEdge(network, edge, 0.5, 1);
  const flat: SpawnWorld = { decks: [], heightAt: () => 1, network, solids: new SolidIndex([]) };
  const withSolids = (solids: readonly Solid[]): SpawnWorld => ({
    ...flat,
    solids: new SolidIndex(solids),
  });
  check("clear street permits a player start", isPlayerSpawnSafe(flat, spawn));
  check(
    "initial loading pose is revalidated against complete static solids",
    !isPlayerSpawnSafe(withSolids([{ maxX: -999, maxZ: 40, minX: -1001, minZ: 38 }]), spawn),
  );
  check(
    "swept opening route catches a thin no-body tree between sample points",
    !isPlayerSpawnSafe(
      withSolids([{ maxX: -998.4, maxZ: 40.1, minX: -998.5, minZ: 39.9, noBody: true }]),
      spawn,
    ),
  );
  check(
    "rotated obstacle corners cannot intrude into the spawn corridor",
    !isPlayerSpawnSafe(
      withSolids([{ maxX: -997, maxZ: 40, minX: -997.5, minZ: 30, yaw: Math.PI / 4 }]),
      spawn,
    ),
  );
  check(
    "spawn camera approach is clear behind the taxi",
    !isPlayerSpawnSafe(withSolids([{ maxX: -999, maxZ: -29, minX: -1001, minZ: -30 }]), spawn),
  );
  check(
    "street starts exclude elevated deck crossings",
    !isPlayerSpawnSafe(
      { ...flat, decks: [{ maxX: -992, maxZ: 55, minX: -1008, minZ: 45, y: 20 }] },
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
    [{ a: 0, b: 1, p: [...behind, ...ahead], w: 6 }],
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
    [{ a: 0, b: 1, p: [-1000, -100, -1000, 40], w: 6 }],
  );
  check(
    "short roads do not promise an unsupported straight opening route",
    !isPlayerSpawnSafe({ ...flat, network: deadEnd }, spawn),
  );
  const firstBlocked = withSolids([{ maxX: -995, maxZ: 200, minX: -1005, minZ: -200 }]);
  const fallback = choosePlayerSpawn(firstBlocked, () => 0);
  check(
    "deterministic fallback validates a different street",
    fallback !== null && fallback.x === -1100 && isPlayerSpawnSafe(firstBlocked, fallback),
  );
  const blocked = withSolids([{ maxX: -900, maxZ: 300, minX: -1200, minZ: -300 }]);
  check(
    "no available route returns failure instead of an unchecked grid spawn",
    choosePlayerSpawn(blocked, () => 0) === null,
  );
};

export const checkInstalledPlayerSpawns = (check: Check, world: SpawnWorld): void => {
  check(
    "installed Silver Terrace trapped start is rejected",
    !isPlayerSpawnSafe(world, FAILED_SAFARI_SPAWN),
  );
  const districts = new Set<string>();
  const origins = new Set<string>();
  let viable = 0;
  let seed = 0x5f_50_41_57;
  const random = (): number => {
    // oxlint-disable-next-line no-bitwise -- LCG needs the uint32 wrap
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  let worstMs = 0;
  const timings: number[] = [];
  for (let i = 0; i < 64; i += 1) {
    const start = performance.now();
    const spawn = choosePlayerSpawn(world, random);
    const elapsed = performance.now() - start;
    timings.push(elapsed);
    worstMs = Math.max(worstMs, elapsed);
    if (!spawn || !isPlayerSpawnSafe(world, spawn)) {
      continue;
    }
    viable += 1;
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
    `${districts.size} districts, ${origins.size} origins: ${[...districts].toSorted().join(", ")}`,
  );
  let safeMidpoints = 0;
  const midpointDistricts = new Set<string>();
  for (const edge of world.network.edges) {
    if (edge.len < 30) {
      continue;
    }
    for (const direction of [-1, 1] satisfies readonly (1 | -1)[]) {
      const candidate = spawnOnEdge(world.network, edge, 0.5, direction);
      if (!isPlayerSpawnSafe(world, candidate)) {
        continue;
      }
      safeMidpoints += 1;
      midpointDistricts.add(districtAt(candidate.gx, candidate.gz).name);
    }
  }
  check(
    "validated deterministic search has broad installed-world coverage",
    safeMidpoints >= 100 && midpointDistricts.size >= 12,
    `${safeMidpoints} directed starts across ${midpointDistricts.size} districts`,
  );
};
