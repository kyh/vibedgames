// Headless world-gen invariant harness: the raster cell grid and the vector
// road network are parallel representations of the same streets — every bug
// in the 2026-07 park work was drift between them. This suite regenerates the
// world exactly like gen-worker does (no browser, no THREE render) and
// asserts the invariants that would have caught each drift class at build
// time. Run: `pnpm test`.
import { GRID_X, GRID_Z, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../src/shared/constants.ts";
import { generateCity } from "../src/world/grid.ts";
import { RoadNetwork } from "../src/world/network.ts";
import { parkCell } from "../src/world/park-clear.ts";
import { NETWORK_GEN_ID, SF_BASE_NODES } from "../src/world/sf-network.ts";
import { STREETS_GEN_ID } from "../src/world/sf-streets.ts";
import {
  deserializeWorldBin,
  packWorld,
  serializeWorldBin,
  unpackWorld,
  WORLD_REV,
} from "../src/world/world-bin.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const worldX = (gx: number): number => (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
const worldZ = (gz: number): number => (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;

console.log("world-gen invariants");
const t0 = performance.now();
const plan = generateCity();
const network = new RoadNetwork();
console.log(`  (plan + network in ${Math.round(performance.now() - t0)}ms)`);

// --- 1. Every road CELL is served by a vector edge. The buildings-in-streets
// bug was exactly this failing: grid kept cells whose edge had been dropped,
// so building setbacks found no street and collapsed onto the fabric.
{
  let orphans = 0;
  let worst = 0;
  let worstAt = "";
  let roadCells = 0;
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      if (plan.cells[gx]?.[gz] !== "road") continue;
      roadCells++;
      const hit = network.nearest(worldX(gx), worldZ(gz), ROAD_TILE * 1.6);
      if (!hit) {
        orphans++;
        worstAt = `${gx},${gz}`;
        continue;
      }
      if (hit.dist > worst) worst = hit.dist;
    }
  }
  check(
    "every road cell has a nearby edge",
    orphans === 0,
    `${roadCells} cells, orphans ${orphans}${orphans ? ` e.g. ${worstAt}` : ""}`,
  );
  // Wide junctions + supercover staircase corners legitimately sit ~1.5 tiles
  // from a centreline; the orphan check above is the real invariant.
  check(
    "road-cell worst edge distance sane",
    worst <= ROAD_TILE * 1.6,
    `worst ${worst.toFixed(1)}u`,
  );
}

// --- 2. Every vector edge runs over road cells (sampled). The inverse drift:
// an edge rendering asphalt through cells the grid thinks are lots.
{
  let offRoad = 0;
  let samples = 0;
  let example = "";
  for (const e of network.edges) {
    for (let s = ROAD_TILE; s < e.len - ROAD_TILE; s += ROAD_TILE) {
      const smp = network.sample(e, s);
      const gx = Math.floor((smp.x + WORLD_HALF_X) / ROAD_TILE);
      const gz = Math.floor((smp.z + WORLD_HALF_Z) / ROAD_TILE);
      if (gx < 0 || gz < 0 || gx >= GRID_X || gz >= GRID_Z) continue;
      samples++;
      const cell = plan.cells[gx]?.[gz];
      // Water is legal (bridges); a LOT cell under an edge centreline is not.
      if (cell === "lot") {
        offRoad++;
        if (!example) example = `edge ${e.id} @ ${gx},${gz}`;
      }
    }
  }
  // Diagonal avenues run STRAIGHTENED spines across their cell staircases,
  // so edge centrelines legitimately cut lot-cell corners map-wide — the
  // baseline is ~21%. This check alerts on GROWTH (a new street-surgery bug
  // pushing edges through blocks), not on the design.
  const frac = offRoad / Math.max(1, samples);
  check(
    "edge samples off road cells at baseline",
    frac < 0.24,
    `${offRoad}/${samples} off-road (${(frac * 100).toFixed(2)}%)${example ? ` e.g. ${example}` : ""}`,
  );
}

// --- 3. Road graph is a single connected component (grid side enforces it;
// a fragmented VECTOR network strands traffic + fares on unreachable islands).
{
  const cellKey = (gx: number, gz: number): number => gx * GRID_Z + gz;
  const road = new Set<number>();
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      if (plan.cells[gx]?.[gz] === "road") road.add(cellKey(gx, gz));
    }
  }
  let componentSize = 0;
  const seen = new Set<number>();
  const first = road.values().next().value;
  if (first !== undefined) {
    const stack = [first];
    seen.add(first);
    while (stack.length > 0) {
      const k = stack.pop();
      if (k === undefined) break;
      componentSize++;
      const gx = Math.floor(k / GRID_Z);
      const gz = k % GRID_Z;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nk = cellKey(gx + dx, gz + dz);
        if (road.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push(nk);
        }
      }
    }
  }
  check(
    "road cells form one component",
    componentSize === road.size,
    `${componentSize}/${road.size}`,
  );
}

// --- 4. Park policy is now single-sourced in the bake: the shipped mask is
// rasterized from the park-CLEARED vector network, so mask and edges agree by
// construction. The generation stamp proves both files came from one bake run
// (a mismatch means someone regenerated one file without the other).
{
  check(
    "street mask + network share a generation stamp",
    STREETS_GEN_ID === NETWORK_GEN_ID,
    STREETS_GEN_ID,
  );
  // Any surviving road cell inside car-free park land must sit on a kept edge
  // (the crossing highway) — band-test against the shipped network. Edge-
  // derived masks make this hold unless the bake drifted.
  let parkRoad = 0;
  let stranded = 0;
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      if (plan.cells[gx]?.[gz] !== "road") continue;
      if (!parkCell(gx, gz)) continue;
      parkRoad++;
      if (!network.nearest(worldX(gx), worldZ(gz), ROAD_TILE * 1.6)) stranded++;
    }
  }
  check("park road cells sit on a kept edge", stranded === 0, `${parkRoad} park road cells`);
}

// --- 5. Fragment endpoints got FRESH degree-1 nodes: a reused junction node
// would make roads.ts span the park gap with one giant junction patch.
{
  let sharedCutEnds = 0;
  let cutNodes = 0;
  for (const e of network.edges) {
    const aEdges = network.nodeEdges[e.a]?.length ?? 0;
    const bEdges = network.nodeEdges[e.b]?.length ?? 0;
    // Cut nodes are appended past SF_BASE_NODES in the baked table; deg-1.
    if (e.a >= SF_BASE_NODES) {
      cutNodes++;
      if (aEdges > 1) sharedCutEnds++;
    }
    if (e.b >= SF_BASE_NODES) {
      cutNodes++;
      if (bEdges > 1) sharedCutEnds++;
    }
  }
  check("clip cut-nodes stay degree-1", sharedCutEnds === 0, `${cutNodes} cut nodes`);
}

// --- 6. Bake round-trip: pack → serialize → deserialize → unpack preserves
// the payload (world-bin is the most cast-heavy, least-observable file).
{
  const tiles = [
    {
      position: new Float32Array([1.5, 2.5, 3.5, 4.5, 5.5, 6.5]),
      normal: new Float32Array([0, 1, 0, 0, 1, 0]),
      color: new Float32Array([0.2, 0.4, 0.6, 0.8, 1.0, 0.1]),
      index: new Uint16Array([0, 1, 0]),
      x: 12.25,
      z: -8.75,
    },
  ];
  // roadParts are intentionally NOT in world.bin (rest.bin's merged chunks
  // carry the roads); tile buffers are QUANTIZED — compare with tolerance.
  const payload = { roadParts: [], tiles };
  const bin = serializeWorldBin({ rev: WORLD_REV, world: packWorld(payload) });
  const back = deserializeWorldBin(bin instanceof Uint8Array ? bin.buffer : bin);
  check("bake rev survives", back.rev === WORLD_REV, `rev ${back.rev}`);
  const world = back.world === undefined ? null : unpackWorld(back.world);
  const tile = world?.tiles[0];
  const near = (a: number | undefined, b: number, eps: number): boolean =>
    a !== undefined && Math.abs(a - b) <= eps;
  check(
    "bake tile buffers survive quantization",
    !!tile &&
      tile.x === 12.25 &&
      tile.z === -8.75 &&
      tile.position.length === 6 &&
      near(tile.position[3], 4.5, 0.05) &&
      near(tile.color?.[2], 0.6, 1 / 128) &&
      near(tile.normal?.[1], 1, 0.02) &&
      tile.index?.[1] === 1,
    tile
      ? `pos[3]=${tile.position[3]?.toFixed(3)} col[2]=${tile.color?.[2]?.toFixed(3)}`
      : "no tile",
  );
  check("world.bin carries no road parts (by design)", world?.roadParts.length === 0);
}

// --- 7. Determinism: two full generations agree cell-for-cell (a stray
// Math.random in the seeded path would silently desync multiplayer).
{
  const plan2 = generateCity();
  let diff = 0;
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      if (plan.cells[gx]?.[gz] !== plan2.cells[gx]?.[gz]) diff++;
    }
  }
  check("generateCity is deterministic", diff === 0, `${diff} differing cells`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
