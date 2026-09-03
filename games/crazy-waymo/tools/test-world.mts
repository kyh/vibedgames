// Headless world-gen invariant harness: the raster cell grid and the vector
// road network are parallel representations of the same streets — every bug
// in the 2026-07 park work was drift between them. This suite regenerates the
// world exactly like gen-worker does (no browser, no THREE render) and
// asserts the invariants that would have caught each drift class at build
// time. Run: `pnpm test`.
import {
  CITY_SEED,
  GRID_X,
  GRID_Z,
  ROAD_TILE,
  WORLD_HALF_X,
  WORLD_HALF_Z,
} from "../src/shared/constants.ts";
import { Rng } from "../src/shared/rng.ts";
import { type FabricLot, planFabricRow } from "../src/world/city.ts";
import { generateCity } from "../src/world/grid.ts";
import {
  dominantCover,
  type GroundCover,
  makeLandClassAt,
  wheelSurface,
} from "../src/world/land-class.ts";
import { freewayPillars } from "../src/world/freeways.ts";
import { landmarkProtection } from "../src/world/landmarks.ts";
import { buildParcelGeometry } from "../src/world/parcel-mesh.ts";
import { planParcels } from "../src/world/parcel-plan.ts";
import { RoadNetwork } from "../src/world/network.ts";
import { buildJunctionMap } from "../src/world/roads.ts";
import { districtAt, makeTerrain } from "../src/world/sf-map.ts";
import { parkCell } from "../src/world/park-clear.ts";
import { SF_ADJACENCY_PARCELS } from "../src/world/sf-adjacency.ts";
import { SF_FOOTPRINTS } from "../src/world/sf-footprints.ts";
import { NETWORK_GEN_ID, SF_BASE_NODES } from "../src/world/sf-network.ts";
import { STREETS_GEN_ID } from "../src/world/sf-streets.ts";
import {
  transitEdges,
  TRANSIT_EDGE_COUNT,
  TRANSIT_GEN_ID,
  TRANSIT_MODES,
} from "../src/world/sf-transit.ts";
import { deserializeWorldBin, unpackWorld, WORLD_REV } from "../src/world/world-bin.ts";
import { packWorld, serializeWorldBin } from "../src/world/world-bin-pack.ts";
import {
  asphaltDepth,
  buildAuditWorld,
  classifySolids,
  landmarkReport,
  loadBakedRest,
  gradeReport,
  overlapReport,
  propInstances,
  propsInRoadway,
  roadIntrusions,
  seatReport,
  solidObb,
  uv,
} from "./geometry-audit.mts";

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
  // baseline was ~21%; the dense hill-grid rungs (rev 34) add short
  // junction-heavy edges of the same class and lift it to ~24.5%. This check
  // alerts on GROWTH (a new street-surgery bug pushing edges through
  // blocks), not on the design. lint:streets' geometry-vs-network sweep is
  // the hard gate for actual strays.
  const frac = offRoad / Math.max(1, samples);
  check(
    "edge samples off road cells at baseline",
    frac < 0.27,
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

// --- 8. Street paint survives the junction clip. The clip used to be a circle
// of radius nodeTrim*1.55 while the patch only reaches nodeTrim along an arm,
// so half the network — the 20-40u blocks that ARE the SF grid — came out with
// no centre line at all ("the street lines just disappear").
{
  const j = buildJunctionMap(network);
  let total = 0;
  let painted = 0;
  let bald = 0;
  for (const edge of network.edges) {
    const tA = network.nodeIsPassThrough(edge.a)
      ? 0
      : Math.min(network.nodeTrim(edge.a), edge.len * 0.45);
    const tB = network.nodeIsPassThrough(edge.b)
      ? 0
      : Math.min(network.nodeTrim(edge.b), edge.len * 0.45);
    const sec = edge.len - tA - tB;
    if (sec <= 0) continue;
    total += sec;
    const steps = Math.max(1, Math.ceil(sec / 4));
    let free = 0;
    for (let i = 0; i <= steps; i++) {
      const smp = network.sample(edge, tA + (i / steps) * sec);
      if (!j.near(smp.x, smp.z, 1.2)) free++;
    }
    const frac = free / (steps + 1);
    painted += frac * sec;
    if (frac < 0.05) bald++;
  }
  const cov = (painted / total) * 100;
  check(
    "centre-line paint covers most of the network",
    cov > 74,
    `${cov.toFixed(1)}% of ${Math.round(total)}u`,
  );
  check("few edges are fully unpainted", bald < 1100, `${bald}/${network.edges.length} bald`);
}

// --- 9. No freeway pillar stands in the roadway. Stamping one every 24u along
// the centreline put 24% of them inside street asphalt as solid trimesh
// columns — SF's viaducts follow the boulevards they were built over.
{
  const terrain = makeTerrain();
  const pillars = freewayPillars(terrain, network);
  let inRoad = 0;
  let inLane = 0;
  for (const p of pillars) {
    const hit = network.nearest(p.x, p.z, 40);
    if (!hit || hit.dist >= hit.edge.half + p.half) continue;
    inRoad++;
    // Where the whole bay is roadway the search falls back to a MEDIAN pier,
    // which reads intentional; a pillar out in a travel lane does not.
    if (hit.dist > 1.5) inLane++;
  }
  check(
    "freeway pillars clear the street asphalt",
    inRoad / pillars.length < 0.05,
    `${inRoad}/${pillars.length} on a street`,
  );
  check("no freeway pillar stands in a travel lane", inLane === 0, `${inLane} in-lane`);
}

// --- 10. The annotation modules index the two baked datasets BY NUMBER, so a
// re-bake silently repoints them. sf-transit.ts is coverage into SF_EDGES and
// carries the network's own stamp; sf-adjacency.ts is an annotation of
// SF_FOOTPRINTS and only needs the parcel count to agree. Both would otherwise
// ship track through buildings / party walls on the wrong parcel with no
// symptom at all. Fix a failure by re-running the extractor, never by editing
// the generated file.
{
  check(
    "transit coverage was built against this network",
    TRANSIT_GEN_ID === NETWORK_GEN_ID,
    `transit ${TRANSIT_GEN_ID} vs network ${NETWORK_GEN_ID}`,
  );
  let outOfRange = 0;
  let covered = 0;
  for (const mode of TRANSIT_MODES) {
    for (const edge of transitEdges(mode)) {
      covered++;
      if (edge < 0 || edge >= network.edges.length) outOfRange++;
    }
  }
  check(
    "every transit edge index is in range",
    outOfRange === 0 && TRANSIT_EDGE_COUNT === network.edges.length,
    `${covered} covered, ${outOfRange} out of range, ${TRANSIT_EDGE_COUNT} vs ${network.edges.length} edges`,
  );
  check(
    "party-wall data covers exactly the shipped footprints",
    SF_ADJACENCY_PARCELS === SF_FOOTPRINTS.length,
    `${SF_ADJACENCY_PARCELS} vs ${SF_FOOTPRINTS.length}`,
  );
}

// --- 11. The fabric LOT LINE. Frontage rows are the bulk of the city's
// buildings, and the walk that lays them used to roll a lot width every
// iteration while stepping by the PREVIOUS roll: consecutive lots gapped or
// overlapped by half the difference of two draws, up to 1.3u (~6 m) of daylight
// between walls that were meant to be attached. planFabricRow now walks a real
// lot line and reports both front-face corners, so the invariant is checkable
// without a browser: within a run, one lot's far corner IS the next one's near
// corner. Curvature is the only slack (neighbours share an offset polyline, so
// the two corners are literally the same sample) — the gate is 0.3u.
{
  const rng = new Rng(CITY_SEED);
  let attachedPairs = 0;
  let worstGap = 0;
  let worstAt = "";
  let denseBuilt = 0;
  let denseWalk = 0;
  let lots = 0;
  for (const edge of network.edges) {
    for (const side of [1, -1] as const) {
      const row = planFabricRow(network, buildJunctionMap(network), edge, side, rng);
      lots += row.length;
      let prev: FabricLot | null = null;
      for (const lot of row) {
        if (lot.attached && prev) {
          // The shared corner: prev's far front corner vs this lot's near one.
          const gap = Math.min(
            Math.hypot(lot.x0 - prev.x1, lot.z0 - prev.z1),
            Math.hypot(lot.x1 - prev.x0, lot.z1 - prev.z0),
          );
          attachedPairs++;
          if (gap > worstGap) {
            worstGap = gap;
            worstAt = `edge ${edge.id} side ${side} run ${lot.run}`;
          }
        }
        prev = lot;
      }
      // Coverage on the rows that are supposed to read as wall-to-wall.
      const smp = network.sample(edge, edge.len / 2);
      const character = districtAt(
        Math.floor((smp.x + WORLD_HALF_X) / ROAD_TILE),
        Math.floor((smp.z + WORLD_HALF_Z) / ROAD_TILE),
      ).character;
      if (character !== "residential" && character !== "victorian") continue;
      const trimA = Math.min(network.nodeTrim(edge.a) * 0.6 + 1.5, edge.len * 0.4);
      const trimB = Math.min(network.nodeTrim(edge.b) * 0.6 + 1.5, edge.len * 0.4);
      const walkable = edge.len - trimA - trimB;
      if (walkable < 5) continue;
      denseWalk += walkable;
      for (const lot of row) denseBuilt += lot.width;
    }
  }
  // The facade line moved in toward the kerb (a flat 2.4u became the street's
  // own sidewalk width plus 0.45u), so the classic "buildings in the road" bug
  // gets a hard gate: no planned lot may overlap asphalt or a junction patch.
  // The junction patch is what a per-edge nearest() cannot see — it is wider
  // than any of its arms.
  {
    const j = buildJunctionMap(network);
    let onAsphalt = 0;
    let inPatch = 0;
    let worstAt = "";
    const rng2 = new Rng(CITY_SEED);
    for (const edge of network.edges) {
      for (const side of [1, -1] as const) {
        for (const lot of planFabricRow(network, j, edge, side, rng2)) {
          for (const [x, z] of [
            [lot.x0, lot.z0],
            [lot.x1, lot.z1],
          ] as const) {
            const hit = network.nearest(x, z, ROAD_TILE * 1.6);
            if (hit && hit.dist < hit.edge.half) {
              onAsphalt++;
              if (!worstAt) worstAt = `edge ${edge.id} side ${side}`;
            } else if (j.near(x, z, 0)) {
              inPatch++;
            }
          }
        }
      }
    }
    check(
      "no fabric facade stands in the roadway",
      onAsphalt === 0 && inPatch === 0,
      `${onAsphalt} on asphalt${worstAt ? ` e.g. ${worstAt}` : ""}, ${inPatch} in a junction patch`,
    );
  }
  check(
    "attached lots leave no wall gap",
    worstGap < 0.3,
    `${attachedPairs} attached pairs, worst ${worstGap.toFixed(3)}u${worstAt ? ` @ ${worstAt}` : ""}`,
  );
  // What the walk can actually cover: runSize lots (median 3) shoulder to
  // shoulder, then one 0.9-2.2u alley, is ~85% of a row; the rest goes to
  // junction aprons, water, park land and cross-street shrinks. Below 0.7 the
  // rhythm has stopped being wall-to-wall, which is the regression this catches.
  const cov = denseBuilt / Math.max(1, denseWalk);
  check(
    "dense rows are built wall-to-wall",
    cov > 0.7,
    `${(cov * 100).toFixed(1)}% of ${Math.round(denseWalk)}u dense frontage, ${lots} lots total`,
  );
}

// --- 12. The resolved ground class (world/land-class.ts) is ONE rule shared by
// the ground paint, the park furniture and the wheel-surface FX. Both of the
// bugs it was written to kill are structural now, so a regression can only come
// from someone re-loosening the resolver — which is what these assert.
{
  const land = makeLandClassAt(plan, makeTerrain());
  const VEGETATED: ReadonlySet<GroundCover> = new Set<GroundCover>([
    "lawn",
    "meadow",
    "grove",
    "conifer",
    "woodland",
    "cemetery",
  ]);
  let vegOnBuilt = 0;
  let beach = 0;
  let sandUnderfoot = 0;
  let vegAt = "";
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      const l = land(worldX(gx), worldZ(gz));
      if (l.shore.kind === "beach") beach++;
      if (wheelSurface(l) === "sand") sandUnderfoot++;
      if (!l.built) continue;
      if (VEGETATED.has(dominantCover(l))) {
        vegOnBuilt++;
        if (!vegAt) vegAt = `${gx},${gz}`;
      }
    }
  }
  // A house standing on a painted lawn was the single most-reported "this looks
  // generated" tell. The resolver cannot emit vegetation on a built cell.
  check(
    "no vegetation is painted on built ground",
    vegOnBuilt === 0,
    `${vegOnBuilt} cells${vegAt ? ` e.g. ${vegAt}` : ""}`,
  );
  // Ocean Beach is ~16u of dry sand and that is verified-correct: any change
  // that "tidies" the coast by shrinking the apron is a regression.
  check("the beach apron never narrows", beach > 8000, `${beach} beach cells`);
  // The wheels read the same resolver the painter does, so a beach cell must
  // kick up sand rather than report concrete.
  check(
    "sand is loose underfoot wherever it is painted",
    sandUnderfoot >= beach,
    `${sandUnderfoot} sand-underfoot vs ${beach} beach cells`,
  );
}

// --- 13. GEOMETRY OF THE SHIPPED WORLD (tools/geometry-audit.mts). Everything
// above reasons about the PLAN; this block audits the artifacts players load —
// every collision box and every batched instance in public/world/rest.bin —
// against the streets and the surfaces that actually get drawn. It answers, by
// measurement rather than by screenshot, the four questions that keep coming
// back: does anything stand in a lane, does anything interpenetrate a
// neighbour, does anything float over its surface, is any landmark parcel
// squatted on.
//
// The counts are RATCHETS, not targets. Each one is the measured state of the
// shipped bins plus a few percent of headroom; lower it as fixes land and never
// raise it to make a change pass. The roadway/prop/seat/squatter numbers came
// down an order of magnitude in rev 63, when every placement pass got a real
// footprint test (city.ts placeOne's roadway gate, fitRectOffAsphalt, the
// footprint-wide reservation test) instead of a two-corner one. `AUDIT_REPORT=1 pnpm vite-node tools/geometry-audit.mts`
// prints the full listing with u/v for every offender.
{
  const { rev, rest } = await loadBakedRest();
  // A stale rest.bin means everything below audits a world nobody loads (and
  // that players are getting a different city from the one this suite checks).
  check("baked rest.bin is at the code's world rev", rev === WORLD_REV, `bin ${rev}`);

  const auditWorld = buildAuditWorld();
  const props = propInstances(rest);
  const cls = classifySolids(rest.solids, auditWorld, props);
  const EMPTY_SOLID = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  const massIdx: number[] = [];
  const furnIdx: number[] = [];
  for (let i = 0; i < rest.solids.length; i++) {
    const c = cls[i];
    if (c === "map-border") continue;
    if (c === "tree" || c === "furniture") furnIdx.push(i);
    else massIdx.push(i);
  }
  const massBoxes = massIdx.map((i) => solidObb(rest.solids[i] ?? EMPTY_SOLID));

  // Attached buildings are the POINT of the lot-line fabric (real party-wall
  // data), so touching, and even a full party-wall band of overlap, is correct:
  // 11.4k of the 19k neighbour pairs interpenetrate at all and the depth
  // histogram peaks at 0.5-1u, which is exactly a shared wall. What is not
  // correct is one mass eating a MEANINGFUL share of another's plan, so the
  // gate is area-based (28% of the smaller box — comfortably past the widest
  // party-wall band measured, 20%) plus the unambiguous case of one box's
  // centre inside another.
  //
  // THE BAR HAS TO CARRY RE-BAKE JITTER. The fabric pass walks
  // `network.edges` in index order, draws from one shared rng per row and
  // claims ground first-come (city.ts) — so ANY map bake that adds or drops an
  // edge renumbers everything after it, re-rolls every later row and lands a
  // different, equally valid arrangement across the whole city. Rev 79 dropped
  // 17 duplicate edges and the count moved 1047 -> 1119 with defects spread
  // map-wide rather than at the 17 sites, which is that reshuffle and not a
  // regression: the class mix is unchanged (still mostly attached
  // real-footprint neighbours) and the depth histogram still tops out under 8u.
  // Keep the headroom; tighten it only alongside a real placement fix.
  const ov = overlapReport(massBoxes, { areaShare: 0.28, minArea: 2 });
  check(
    "solid interpenetration stays at its ratchet",
    ov.defects.length <= 1150,
    `${ov.defects.length} defects of ${ov.touching} touching pairs` +
      (ov.defects[0] ? `, worst ${uv(ov.defects[0].x, ov.defects[0].z)}` : ""),
  );

  // Buildings in the road: corners AND edge midpoints against the drawn
  // asphalt. >0.5u past the kerb line is "in the road" rather than "on the
  // kerb" (the placement passes clear the kerb by 0.2-0.6u); >3u is a car's
  // width into a travel lane, which is the class that actually blocks driving.
  const inRoad = roadIntrusions(massBoxes, network, 0.5);
  const deep = inRoad.filter((r) => r.depth > 3);
  check(
    "masses in the roadway stay at their ratchet",
    inRoad.length <= 340 && deep.length <= 8,
    `${inRoad.length} past the kerb, ${deep.length} over 3u deep` +
      (deep[0] ? `, worst ${deep[0].depth.toFixed(1)}u @ ${uv(deep[0].x, deep[0].z)}` : ""),
  );
  // The landmark reservation boxes are INVISIBLE (the monument is the visual),
  // so one standing in a lane is a wall out of nowhere — the worst kind.
  const invisibleInRoad = inRoad.filter((r) => cls[massIdx[r.index] ?? 0] === "landmark");
  check(
    "invisible landmark boxes in the roadway stay at their ratchet",
    invisibleInRoad.length <= 24,
    `${invisibleInRoad.length}` +
      (invisibleInRoad[0]
        ? ` worst ${invisibleInRoad[0].depth.toFixed(1)}u @ ${uv(invisibleInRoad[0].x, invisibleInRoad[0].z)}`
        : ""),
  );

  // Street furniture, trees and parked cars. Roadworks props (cones, barriers,
  // lights, the work vehicle behind the chicane) are ON the asphalt by design —
  // furniture.ts opts them in explicitly — so they are excluded by name.
  // Parked cars sit 1.05u inside the asphalt by design (off = half − 1.05);
  // past ~2.5u a car has drifted out of the parking strip into a lane.
  const furnInRoad = roadIntrusions(
    furnIdx.map((i) => solidObb(rest.solids[i] ?? EMPTY_SOLID)),
    network,
    0.5,
  );
  const inLane = propsInRoadway(props, network, auditWorld.standAt, 0.5);
  const propsDeep = inLane.filter((p) => p.depth > 2.5).length;
  let carsInLane = 0;
  let carWorst = 0;
  for (const c of rest.parkedCars) {
    const d = asphaltDepth(network, c.x, c.z);
    if (d > 2.5) carsInLane++;
    if (d > carWorst) carWorst = d;
  }
  check(
    "kerb props and parked cars stay out of the lanes at their ratchet",
    furnInRoad.length <= 12 && inLane.length <= 20 && propsDeep <= 6 && carsInLane <= 12,
    `${furnInRoad.length} furniture solids, ${inLane.length} ground-level instances past ` +
      `the kerb (${propsDeep} over 2.5u), ${carsInLane} parked cars out of the strip ` +
      `(worst ${carWorst.toFixed(1)}u)`,
  );

  // Seat heights. Nothing in this world sits on the raw height field (see
  // CLAUDE.md): props seat through ground.ts makeStandingSurface. The measure
  // is per KIND against its own baseline — a model's origin is not its feet —
  // and only fixed-scale ground props qualify (a mass cuts into its own grade
  // and a plinth fills what is left, by design).
  const seat = seatReport(props, auditWorld.standAt, auditWorld.terrainAt, {
    floatGap: 0.35,
    buryDepth: 0.6,
    minCount: 40,
    groundSpread: 0.3,
  });
  const wrongSurface = seat.groups.filter((g) => g.wrongSurface);
  // Rev 70 halved this: the park gate pillars sampled ONE surface height for a
  // pair standing 4.4u apart, the park walls seated on the LOWEST point under
  // a 4.3u run (which sank 80 of them under the lawn), the tile skirt's height
  // was a function of the terrain rather than a fixed size, and four unrelated
  // props shared one BoxGeometry — and the rest capture keys raw geometry by
  // identity, so all four were measured against one meaningless baseline.
  // Rev 72 took the shore lip too (it sampled the surface 1.6u INLAND of a lip
  // it draws on the cell boundary; on a bluff those differ by up to 6.8u):
  // 1045 floating -> 745. What is left is almost entirely kk-tree-b and
  // kk-trafficlight, whose GLBs carry the authoring offset in the mesh NODE,
  // so the matrix the bake serializes is up to 1.7u from the trunk the prop
  // actually stands on — their seat spread is 0.00 once that is taken back
  // out, i.e. they are planted and this number is the MEASURE being wrong.
  // Fixing that is a src/assets/loader.ts change, and it is worth doing before
  // anyone spends more effort driving this count down.
  check(
    "seated props stay on the drawn surface at their ratchet",
    seat.floating <= 820 && seat.buried <= 285 && wrongSurface.length === 0,
    `${seat.floating} floating, ${seat.buried} buried, ` +
      `${wrongSurface.length} kinds tracking the raw field` +
      (wrongSurface[0] ? ` (${wrongSurface[0].url})` : ""),
  );

  // Landmark parcels. Wave 0 shipped a skyscraper inside Oracle Park's bowl
  // because the reservations had not been re-baked; this asks the shipped
  // artifacts directly, for all 20 landmarks.
  const lm = landmarkReport(props, rest.solids, network, plan);
  const bowlSquatters = lm.intruders.filter((i) => i.landmark === "Oracle Park");
  check(
    "no procedural mass stands inside Oracle Park",
    bowlSquatters.length === 0,
    `${lm.reservedCells} reserved cells across ${lm.landmarks.length} landmarks`,
  );
  // What survives is the shore blocker on the ONE reserved water cell a street
  // still runs up to: a landmark owns its own shore (city.ts defers there), but
  // a drivable approach keeps its barrier whoever owns the parcel.
  check(
    "landmark-parcel squatters stay at their ratchet",
    lm.intruders.length <= 2,
    `${lm.intruders.length} intruders` +
      (lm.intruders[0]
        ? `, e.g. ${lm.intruders[0].landmark}: ${lm.intruders[0].what} @ ${uv(lm.intruders[0].x, lm.intruders[0].z)}`
        : ""),
  );

  // Street grade, measured on the DRAPE that is drawn (not the raw field):
  // ground.ts's MAX_RAMP_GRADE = 0.42 is what the terrace pass aims for, but
  // its delta is capped at 2.4u so a genuine SF hill still comes through
  // steeper. The gate is that new hills cannot make the map less driveable
  // than rev 60 measured it: 169 edges over the target, worst 75.6%.
  const grade = gradeReport(network, auditWorld.drapeAt, 0.42);
  check(
    "no street is steeper than the map already is",
    grade.worstChord < 0.78 && grade.overChord <= 180,
    `worst ${(grade.worstChord * 100).toFixed(1)}% @ ${grade.worstChordAt}, ` +
      `${grade.overChord} edges over 42%`,
  );
}

// --- The parcel fabric: procedural buildings on the real footprints
// (parcel-plan.ts / parcel-mesh.ts). It is built LIVE on both load paths and
// never enters the bins, so it is audited from the plan itself — the same
// pure function the game runs — rather than from rest.bin.
{
  const prot = landmarkProtection(plan, network);
  const terrain = makeTerrain();
  const t0 = performance.now();
  const parcels = planParcels({ network, terrain, reserved: prot.reserved });
  const planMs = Math.round(performance.now() - t0);
  const again = planParcels({ network, terrain, reserved: prot.reserved });
  const sig = (r: typeof parcels): string =>
    r.plans
      .map(
        (p) => `${p.id}:${p.kind}:${p.units}:${(p.ring[0] ?? 0).toFixed(3)}:${p.height.toFixed(3)}`,
      )
      .join("|");
  check(
    "parcel plan is deterministic",
    sig(parcels) === sig(again),
    `${parcels.plans.length} parcels in ${planMs}ms`,
  );
  const s = parcels.stats;
  // The old kit pass built 2,890 of these; the kerb clip is what lifts it.
  check(
    "real parcels build instead of being rejected",
    s.built >= 15000 && s.onRoad + s.clipped <= 3000,
    `${s.built} of ${SF_FOOTPRINTS.length} built (${s.onRoad} in a lane, ${s.clipped} clipped away, ` +
      `${s.folded} folded, ${s.straddle} straddling, ${s.stacked} stacked, ${s.park} park, ` +
      `${s.reserved} reserved, ${s.freeway} freeway, ${s.cliff} cliff, ${s.stretched} stretched)`,
  );
  // Every wall vertex clears the drawn asphalt — that is what the clip is for.
  let pastKerb = 0;
  let worst = 0;
  let worstAt = "";
  for (const p of parcels.plans) {
    for (let i = 0; i < p.n; i++) {
      const x = p.ring[i * 2] ?? 0;
      const z = p.ring[i * 2 + 1] ?? 0;
      const d = asphaltDepth(network, x, z);
      if (d <= 0.5) continue;
      pastKerb++;
      if (d > worst) {
        worst = d;
        worstAt = uv(x, z);
      }
    }
  }
  check(
    "parcel walls stay off the asphalt",
    pastKerb === 0,
    `${pastKerb} vertices past the kerb` +
      (worst > 0 ? `, worst ${worst.toFixed(1)}u @ ${worstAt}` : ""),
  );
  const boxes = parcels.plans.flatMap((p) => p.solids).map(solidObb);
  const inRoad = roadIntrusions(boxes, network, 0.5);
  const deep = inRoad.filter((r) => r.depth > 3);
  check(
    "parcel solids stay out of the lanes",
    inRoad.length <= 250 && deep.length === 0,
    `${boxes.length} solids, ${inRoad.length} past the kerb, ${deep.length} over 3u deep` +
      (deep[0] ? `, worst ${deep[0].depth.toFixed(1)}u @ ${uv(deep[0].x, deep[0].z)}` : ""),
  );
  const kinds = new Map<string, number>();
  for (const p of parcels.plans) kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1);
  const k = (name: string): number => kinds.get(name) ?? 0;
  check(
    "the fabric has the San Francisco mix",
    k("rowhouse") + k("stucco") >= 6000 && k("midrise") >= 1500 && k("tower") >= 60,
    [...kinds.entries()].map(([n, c]) => `${n} ${c}`).join(", "),
  );
  // Vertex budget: the whole fabric lives on the GPU at once (chunks hide,
  // they do not unload), so this is memory as much as it is draw time.
  const t1 = performance.now();
  const full = await buildParcelGeometry(parcels.plans, 2);
  const fullMs = Math.round(performance.now() - t1);
  check(
    "parcel geometry fits the desktop budget",
    full.stats.vertices <= 4_500_000,
    `${full.stats.vertices} verts, ${Math.round(full.stats.triangles)} tris, ${full.stats.buffers} buffers in ${fullMs}ms`,
  );
  const phone = await buildParcelGeometry(parcels.plans, 1);
  check(
    "parcel geometry fits the phone budget",
    phone.stats.vertices <= 2_600_000,
    `${phone.stats.vertices} verts, ${phone.stats.buffers} buffers`,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
