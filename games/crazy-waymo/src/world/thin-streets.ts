// Topology-preserving thinning of the rasterized street grid.
//
// The OSM rasterizer (tools/sf-data/rasterize.mjs) supercover-fills every
// street segment, and its bake-time thinning refuses to touch arterial cells —
// so wide boulevards and close parallel ways arrive as 2-cell-thick runs. The
// autotiler then renders those as chains of T/crossroad tiles: stacked streets,
// asphalt plazas, and stranded sidewalk slivers where poles land mid-road.
//
// This pass erodes every thick run back to a single cell while provably
// keeping the street network's 4-connectivity: a cell is only removed when
// (a) it sits inside a fully-road 2×2 square (evidence of thickness — 1-wide
// streets, bends and supercover staircases are never touched), (b) it is not a
// dead-end tip, and (c) all of its road 4-neighbours stay 4-connected through
// the remaining ring of its 3×3 neighbourhood (the digital-topology "simple
// point" test — local rerouting exists, so global connectivity is preserved).
// Peeling runs in N/E/S/W border sub-passes so runs collapse toward one side
// instead of dissolving raggedly from both.

// Ring order around a cell: consecutive entries are 4-adjacent to each other.
// Even indices are the centre's 4-neighbours (N, E, S, W).
const RING: readonly (readonly [number, number])[] = [
  [0, -1], // N
  [1, -1], // NE
  [1, 0], // E
  [1, 1], // SE
  [0, 1], // S
  [-1, 1], // SW
  [-1, 0], // W
  [-1, -1], // NW
];

// Border-peel order per sub-pass: remove only cells whose neighbour on this
// side is open, so each sub-pass shaves one face of a thick run.
const PEEL: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

const MAX_SWEEPS = 12; // 2-wide runs settle in 1–2; plazas in a few more

// Thin `road` (1 = street, indexed gx * sizeZ + gz) in place. Returns the
// number of cells removed.
export function thinStreets(road: Uint8Array, sizeX: number, sizeZ: number): number {
  const at = (x: number, z: number): boolean =>
    x >= 0 && z >= 0 && x < sizeX && z < sizeZ && road[x * sizeZ + z] === 1;

  // Any of the four quadrant 2×2 squares fully road? (thickness evidence)
  const inSquare = (x: number, z: number): boolean => {
    for (const dx of [-1, 1] as const) {
      for (const dz of [-1, 1] as const) {
        if (at(x + dx, z) && at(x, z + dz) && at(x + dx, z + dz)) return true;
      }
    }
    return false;
  };

  // Simple-point test: every road 4-neighbour of (x, z) must lie on ONE
  // contiguous road arc of the 8-ring — then any path through the centre can
  // reroute around it and removal cannot split the network.
  const removable = (x: number, z: number): boolean => {
    let n4 = 0;
    const ring: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      const d = RING[i];
      const r = d !== undefined && at(x + d[0], z + d[1]);
      ring.push(r);
      if (r && i % 2 === 0) n4++;
    }
    if (n4 < 2) return false; // endpoint or isolated — never erode street length
    if (!inSquare(x, z)) return false;
    // Count maximal cyclic arcs of road ring cells that contain a 4-neighbour.
    let arcsWithN4 = 0;
    let allRoad = true;
    for (let i = 0; i < 8; i++) {
      if (!ring[i]) {
        allRoad = false;
        continue;
      }
      const prev = ring[(i + 7) % 8];
      if (prev) continue; // interior of an arc — counted at its start
      // Walk this arc; does it hold a 4-neighbour?
      for (let j = i; ring[j % 8] && j < i + 8; j++) {
        if (j % 2 === 0) {
          arcsWithN4++;
          break;
        }
      }
    }
    if (allRoad) return true; // full ring: always reroutable
    return arcsWithN4 === 1;
  };

  let removed = 0;
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let changed = false;
    for (const peel of PEEL) {
      for (let x = 0; x < sizeX; x++) {
        for (let z = 0; z < sizeZ; z++) {
          if (road[x * sizeZ + z] !== 1) continue;
          if (at(x + peel[0], z + peel[1])) continue; // not on this sub-pass's border
          if (!removable(x, z)) continue;
          road[x * sizeZ + z] = 0; // sequential removal keeps the test exact
          removed++;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return removed;
}
