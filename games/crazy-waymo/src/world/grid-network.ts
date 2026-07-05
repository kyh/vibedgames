import { ROAD_TILE } from "../shared/constants";
import { DIR_DELTA, E, N, S, W, type Dir } from "../shared/types";
import type { CityPlan } from "./grid";
import { ROAD_STRAIGHT } from "../assets/manifest";
import type { RawEdge } from "./sf-network";

// Derive the sim road graph FROM THE TILE GRID, so traffic, fares, spawns and
// building alignment agree exactly with the Kenney street tiles on screen.
// Nodes are the non-straight cells (junctions, bends, dead ends); edges are
// the straight runs of cells between them.

// Asphalt half-width of the Kenney road tiles at ROAD_TILE scale (the road
// surface spans ~2/3 of the tile; the rest is kerb + sidewalk).
export const TILE_ROAD_HALF = ROAD_TILE * 0.31;

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
    edges.push({
      a,
      b,
      w: TILE_ROAD_HALF,
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
  return { nodes, edges };
}
