// Street regression harness: pnpm lint:streets (runs under vite-node).
// Generates the city's street graph + geometry headlessly and asserts the
// invariants that every screenshot bug so far has violated. Fails loudly —
// run it before deploying street changes.

import { generateCity } from "../src/world/grid";
import { buildGridNetwork } from "../src/world/grid-network";
import { RoadNetwork } from "../src/world/network";
import { buildRoads } from "../src/world/roads";
import { makeTerrain } from "../src/world/sf-map";
import { GRID_X, GRID_Z, ROAD_TILE } from "../src/shared/constants";

let failures = 0;
const check = (ok: boolean, label: string, detail = ""): void => {
  if (ok) {
    console.log(`  ok  ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` (${detail})` : ""}`);
  }
};

console.log("street-lint: generating city…");
const plan = generateCity();
const terrain = makeTerrain();
const worldX = (gx: number): number => (gx + 0.5) * ROAD_TILE - (GRID_X * ROAD_TILE) / 2;
const worldZ = (gz: number): number => (gz + 0.5) * ROAD_TILE - (GRID_Z * ROAD_TILE) / 2;
// Pristine cities run the baked vector network; also build the grid-derived
// graph (editor fallback) so both paths stay healthy.
const network = new RoadNetwork();
{
  const raw = buildGridNetwork(plan, worldX, worldZ);
  const gridNet = new RoadNetwork(raw.nodes, raw.edges);
  console.log(
    `grid-derived fallback: ${gridNet.edges.length} edges (vector: ${network.edges.length})`,
  );
}

// --- 1. Mask sanity ---
let roadCells = 0;
for (const col of plan.cells) for (const c of col) if (c === "road") roadCells++;
check(roadCells > 4000 && roadCells < 60000, "mask cell count in range", String(roadCells));

// --- 2. Graph invariants ---
check(network.edges.length > 800, "edge count sane", String(network.edges.length));
let zeroLen = 0;
let nanPts = 0;
for (const e of network.edges) {
  if (!(e.len > 0.5)) zeroLen++;
  for (let i = 0; i < e.pts.length; i++) {
    const v = e.pts[i];
    if (v === undefined || !Number.isFinite(v)) nanPts++;
  }
}
check(zeroLen === 0, "no zero-length edges", String(zeroLen));
check(nanPts === 0, "all polyline points finite", String(nanPts));

// Single connected component (traffic/fares must reach everything).
{
  const adj = new Map<number, number[]>();
  for (const e of network.edges) {
    (adj.get(e.a) ?? adj.set(e.a, []).get(e.a))?.push(e.b);
    (adj.get(e.b) ?? adj.set(e.b, []).get(e.b))?.push(e.a);
  }
  const seen = new Set<number>();
  const start = network.edges[0];
  if (start) {
    const stack = [start.a];
    seen.add(start.a);
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined) break;
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
  }
  const connectedNodes = new Set<number>();
  for (const e of network.edges) {
    connectedNodes.add(e.a);
    connectedNodes.add(e.b);
  }
  check(
    seen.size === connectedNodes.size,
    "graph is one connected component",
    `${seen.size}/${connectedNodes.size} nodes reachable`,
  );
}

// Max node degree sane (a runaway cluster shows up here first).
{
  let maxDeg = 0;
  for (const ids of network.nodeEdges) maxDeg = Math.max(maxDeg, ids?.length ?? 0);
  check(maxDeg <= 12, "max junction degree <= 12", String(maxDeg));
}

// --- 3. Geometry invariants (the planar map) ---
console.log("street-lint: building road geometry…");
const meshes = buildRoads(network, terrain);
check(meshes.length >= 3, "road meshes built", String(meshes.length));
let nonFinite = 0;
let degenerate = 0;
let tris = 0;
for (const mesh of meshes) {
  const pos = mesh.geometry.getAttribute("position");
  if (!pos) continue;
  // Conformed geometry is INDEXED (welded verts): resolve triangle corners
  // through the index — consecutive position triples are not triangles.
  const idx = mesh.geometry.index;
  const vertCount = idx ? idx.count : pos.count;
  const vid = (k: number): number => (idx ? idx.getX(k) : k);
  for (let i = 0; i + 2 < vertCount; i += 3) {
    tris++;
    const ax = pos.getX(vid(i));
    const ay = pos.getY(vid(i));
    const az = pos.getZ(vid(i));
    const bx = pos.getX(vid(i + 1));
    const bz = pos.getZ(vid(i + 1));
    const cx = pos.getX(vid(i + 2));
    const cz = pos.getZ(vid(i + 2));
    if (![ax, ay, az, bx, bz, cx, cz].every(Number.isFinite)) nonFinite++;
    // Spike detector: street geometry must stay NEAR the street network.
    // (this is the invariant every historical "stray sliver" bug violated)
    if (i % 33 === 0) {
      const mx = (ax + bx + cx) / 3;
      const mz = (az + bz + cz) / 3;
      const hit = network.nearest(mx, mz, 30);
      const limit = (hit ? hit.edge.half : 7) + 8;
      if (!hit || hit.dist > limit) {
        // Junction patches at wide nodes extend past the per-edge bound.
        let nearNode = false;
        for (let n = 0; n < network.nodes.length && !nearNode; n++) {
          const node = network.nodes[n];
          if (!node || (network.nodeEdges[n]?.length ?? 0) === 0) continue;
          if (Math.hypot(node[0] - mx, node[1] - mz) < network.nodeTrim(n) * 2.4) nearNode = true;
        }
        if (!nearNode) degenerate++;
      }
    }
  }
}
check(nonFinite === 0, "all road vertices finite", String(nonFinite));
check(
  degenerate === 0,
  "no street geometry far from the network",
  `${degenerate} sampled of ${tris}`,
);

// --- 4. Markings stay out of junction areas ---
// (dash geometry is emitted per-edge; every dash midpoint was already
// node-clipped in buildRoads — re-verify from the meshes' yellow material)
{
  let strayDashes = 0;
  const yellow = meshes.filter((m) => {
    const mat = m.material;
    return (
      !Array.isArray(mat) &&
      "color" in mat &&
      (mat as { color: { getHexString(): string } }).color.getHexString() === "d8a23c"
    );
  });
  for (const mesh of yellow) {
    const pos = mesh.geometry.getAttribute("position");
    if (!pos) continue;
    for (let i = 0; i + 2 < pos.count; i += 30) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      // dash quads are small; skip long edge-line strips
      const ext = Math.max(
        Math.abs(pos.getX(i + 1) - x),
        Math.abs(pos.getZ(i + 1) - z),
        Math.abs(pos.getX(i + 2) - x),
        Math.abs(pos.getZ(i + 2) - z),
      );
      if (ext > 4) continue;
      for (let n = 0; n < network.nodes.length; n++) {
        const ids = network.nodeEdges[n];
        if (!ids || ids.length < 3) continue;
        const node = network.nodes[n];
        if (!node) continue;
        if (Math.hypot(node[0] - x, node[1] - z) < network.nodeTrim(n) * 0.6) {
          strayDashes++;
          break;
        }
      }
    }
  }
  check(strayDashes === 0, "no dashes inside junction cores", String(strayDashes));
}

console.log(
  failures === 0 ? "\nstreet-lint: ALL CHECKS PASSED" : `\nstreet-lint: ${failures} FAILURES`,
);
if (failures > 0) process.exit(1);
