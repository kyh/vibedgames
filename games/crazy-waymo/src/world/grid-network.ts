import { ROAD_TILE } from "../shared/constants";
import { DIR_DELTA, E, N, S, W, type Dir } from "../shared/types";
import type { CityPlan } from "./grid";
import { ROAD_STRAIGHT } from "../assets/manifest";
import type { RawEdge } from "./sf-network";
import { majorMaskAt } from "./sf-streets";

// Derive the sim road graph FROM THE TILE GRID, so traffic, fares, spawns and
// building alignment agree exactly with the Kenney street tiles on screen.
// Nodes are the non-straight cells (junctions, bends, dead ends); edges are
// the straight runs of cells between them.

// Street half-widths (arcade-wide, Driver:SF energy): majors are boulevards.
export const TILE_ROAD_HALF = ROAD_TILE * 0.36;
export const MAJOR_ROAD_HALF = ROAD_TILE * 0.5;

export function buildGridNetwork(
  plan: CityPlan,
  worldX: (gx: number) => number,
  worldZ: (gz: number) => number,
): { nodes: [number, number][]; edges: RawEdge[] } {
  const nodes: [number, number][] = [];
  const nodeAt = new Map<string, number>();
  const isRoad = (gx: number, gz: number): boolean =>
    gx >= 0 && gz >= 0 && gx < plan.sizeX && gz < plan.sizeZ && plan.cells[gx]?.[gz] === "road";
  const isNode = (gx: number, gz: number): boolean => {
    const road = plan.roads[gx]?.[gz];
    if (!road) return false;
    return road.tile !== ROAD_STRAIGHT;
  };
  const nodeId = (gx: number, gz: number): number => {
    const k = `${gx},${gz}`;
    let id = nodeAt.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodeAt.set(k, id);
      nodes.push([worldX(gx), worldZ(gz)]);
    }
    return id;
  };

  const edges: RawEdge[] = [];
  const walked = new Set<string>(); // "gx,gz,dir" from a node cell

  const walk = (gx: number, gz: number, dir: Dir): void => {
    const k = `${gx},${gz},${dir}`;
    if (walked.has(k)) return;
    walked.add(k);
    const [dx, dz] = DIR_DELTA[dir];
    if (!isRoad(gx + dx, gz + dz)) return;
    const a = nodeId(gx, gz);
    let cx = gx + dx;
    let cz = gz + dz;
    let steps = 1;
    while (!isNode(cx, cz) && steps < 10000) {
      cx += dx;
      cz += dz;
      steps++;
      if (!isRoad(cx, cz)) return; // broken run (should not happen post-prune)
    }
    // Mark the reverse walk done so the edge is emitted once.
    const back: Dir = dir === N ? S : dir === S ? N : dir === E ? W : E;
    walked.add(`${cx},${cz},${back}`);
    const b = nodeId(cx, cz);
    if (a === b && steps < 2) return;
    // Class by majority of run cells: primary/secondary sweeps get boulevard
    // width, everything else stays street-scale.
    let majors = 0;
    let total = 0;
    for (let k = 0; k <= steps; k++) {
      if (majorMaskAt(gx + dx * k, gz + dz * k)) majors++;
      total++;
    }
    edges.push({
      a,
      b,
      w: majors > total * 0.5 ? MAJOR_ROAD_HALF : TILE_ROAD_HALF,
      p: [worldX(gx), worldZ(gz), worldX(cx), worldZ(cz)],
    });
  };

  for (let gx = 0; gx < plan.sizeX; gx++) {
    for (let gz = 0; gz < plan.sizeZ; gz++) {
      if (!isNode(gx, gz)) continue;
      walk(gx, gz, N);
      walk(gx, gz, E);
      walk(gx, gz, S);
      walk(gx, gz, W);
    }
  }

  // --- Smooth the graph: a 45-degree street rasterizes to a staircase of
  // bend "nodes"; contract every degree-2 node into its neighbours' polyline,
  // then RDP-simplify. Staircases collapse to true diagonals (deviation is
  // under a half-cell), real 90-degree corners survive (their corner vertex
  // deviates by half the block length). Hills' switchback chains become
  // smooth curves. ---
  const degree = new Map<number, number>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  let merged = true;
  let live: (RawEdge | null)[] = [...edges];
  while (merged) {
    merged = false;
    const byNode = new Map<number, number[]>();
    live.forEach((e, i) => {
      if (!e) return;
      for (const n of [e.a, e.b]) {
        const arr = byNode.get(n) ?? [];
        arr.push(i);
        byNode.set(n, arr);
      }
    });
    for (const [n, idxs] of byNode) {
      if (degree.get(n) !== 2 || idxs.length !== 2) continue;
      const i1 = idxs[0];
      const i2 = idxs[1];
      if (i1 === undefined || i2 === undefined || i1 === i2) continue;
      const e1 = live[i1];
      const e2 = live[i2];
      if (!e1 || !e2 || e1.a === e1.b || e2.a === e2.b) continue;
      // Orient e1 to END at n and e2 to START at n, then splice.
      const p1 = e1.b === n ? e1.p : reversePts(e1.p);
      const a = e1.b === n ? e1.a : e1.b;
      const p2 = e2.a === n ? e2.p : reversePts(e2.p);
      const b = e2.a === n ? e2.b : e2.a;
      if (a === b) continue; // keep loops as two edges
      live[i1] = { a, b, w: Math.max(e1.w, e2.w), p: [...p1, ...p2.slice(2)] };
      live[i2] = null;
      merged = true;
    }
    if (merged) live = live.filter((e) => e !== null);
  }
  // Fuse junction clusters: two junction cells side by side leave a 1-cell
  // edge whose sweep is fully consumed by trims — both patches then flood the
  // area into an asphalt lake with stranded kerb islands. Contract the short
  // edge and merge the nodes at its midpoint.
  const pLen = (p: readonly number[]): number => {
    let L = 0;
    for (let i = 2; i < p.length; i += 2) {
      L += Math.hypot((p[i] ?? 0) - (p[i - 2] ?? 0), (p[i + 1] ?? 0) - (p[i - 1] ?? 0));
    }
    return L;
  };
  let contracted = true;
  while (contracted) {
    contracted = false;
    for (let i = 0; i < live.length; i++) {
      const e = live[i];
      if (!e || e.a === e.b) continue;
      if (pLen(e.p) >= ROAD_TILE * 1.45) continue;
      const keep = e.a;
      const drop = e.b;
      const ka = nodes[keep];
      const kb = nodes[drop];
      if (!ka || !kb) continue;
      nodes[keep] = [(ka[0] + kb[0]) / 2, (ka[1] + kb[1]) / 2];
      for (let j = 0; j < live.length; j++) {
        const f = live[j];
        if (!f) continue;
        if (f.a === drop || f.b === drop) {
          live[j] = { ...f, a: f.a === drop ? keep : f.a, b: f.b === drop ? keep : f.b };
        }
      }
      live[i] = null;
      contracted = true;
    }
    if (contracted) live = live.filter((e) => e !== null);
  }
  // Snap every polyline end to its (possibly moved) node, drop self-loops
  // shorter than a block, then simplify.
  const out: RawEdge[] = [];
  for (const e of live) {
    if (!e) continue;
    if (e.a === e.b && pLen(e.p) < 45) continue;
    const na = nodes[e.a];
    const nb = nodes[e.b];
    if (!na || !nb) continue;
    const p = [...e.p];
    p[0] = na[0];
    p[1] = na[1];
    p[p.length - 2] = nb[0];
    p[p.length - 1] = nb[1];
    out.push({ ...e, p: chaikin(rdp(p, ROAD_TILE * 0.42)) });
  }
  return { nodes, edges: out };
}

// One Chaikin corner-cutting pass (endpoints pinned). RDP leaves shallow
// streets with 1-cell jogs (their chord deviation beats the epsilon); cutting
// corners turns jogs into gentle curves and L-bends into real turn radii.
function chaikin(p: readonly number[]): number[] {
  const n = p.length / 2;
  if (n <= 2) return [...p];
  const out: number[] = [p[0] ?? 0, p[1] ?? 0];
  for (let i = 0; i + 1 < n; i++) {
    const ax = p[i * 2] ?? 0;
    const az = p[i * 2 + 1] ?? 0;
    const bx = p[i * 2 + 2] ?? 0;
    const bz = p[i * 2 + 3] ?? 0;
    out.push(ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25);
    out.push(ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75);
  }
  out.push(p[(n - 1) * 2] ?? 0, p[(n - 1) * 2 + 1] ?? 0);
  return out;
}

function reversePts(p: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i] ?? 0, p[i + 1] ?? 0);
  return out;
}

// Ramer–Douglas–Peucker over a flat [x,z,...] polyline.
function rdp(p: readonly number[], eps: number): number[] {
  const n = p.length / 2;
  if (n <= 2) return [...p];
  const x0 = p[0] ?? 0;
  const z0 = p[1] ?? 0;
  const x1 = p[(n - 1) * 2] ?? 0;
  const z1 = p[(n - 1) * 2 + 1] ?? 0;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz) || 1;
  let maxD = -1;
  let maxI = 1;
  for (let i = 1; i + 1 < n; i++) {
    const d = Math.abs(((p[i * 2] ?? 0) - x0) * dz - ((p[i * 2 + 1] ?? 0) - z0) * dx) / len;
    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }
  if (maxD <= eps) return [x0, z0, x1, z1];
  const l = rdp(p.slice(0, maxI * 2 + 2), eps);
  const r = rdp(p.slice(maxI * 2), eps);
  return [...l.slice(0, -2), ...r];
}
