import { ROAD_TILE } from "../shared/constants";
import { DIR_DELTA, E, N, S, W } from "../shared/types";
import type { Dir } from "../shared/types";
import type { CityPlan } from "./grid";
import type { RawEdge } from "./sf-network";
import { majorMaskAt } from "./sf-streets";

export const TILE_ROAD_HALF = ROAD_TILE * 0.36;
export const MAJOR_ROAD_HALF = ROAD_TILE * 0.5;

const OPPOSITE_DIR = { 0: S, 1: W, 2: N, 3: E } satisfies Record<Dir, Dir>;

const chaikin = (p: readonly number[]) => {
  const n = p.length / 2;

  if (n <= 2) {
    return [...p];
  }

  const out: number[] = [p[0] ?? 0, p[1] ?? 0];

  for (let i = 0; i + 1 < n; i += 1) {
    const ax = p[i * 2] ?? 0;
    const az = p[i * 2 + 1] ?? 0;
    const bx = p[i * 2 + 2] ?? 0;
    const bz = p[i * 2 + 3] ?? 0;
    out.push(
      ax * 0.75 + bx * 0.25,
      az * 0.75 + bz * 0.25,
      ax * 0.25 + bx * 0.75,
      az * 0.25 + bz * 0.75,
    );
  }

  out.push(p[(n - 1) * 2] ?? 0, p[(n - 1) * 2 + 1] ?? 0);

  return out;
};

const reversePts = (p: readonly number[]) => {
  const out: number[] = [];

  for (let i = p.length - 2; i >= 0; i -= 2) {
    out.push(p[i] ?? 0, p[i + 1] ?? 0);
  }

  return out;
};

const rdp: (p: readonly number[], eps: number) => number[] = (p, eps) => {
  const n = p.length / 2;

  if (n <= 2) {
    return [...p];
  }

  const x0 = p[0] ?? 0;
  const z0 = p[1] ?? 0;
  const x1 = p[(n - 1) * 2] ?? 0;
  const z1 = p[(n - 1) * 2 + 1] ?? 0;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz) || 1;
  let maxD = -1;
  let maxI = 1;

  for (let i = 1; i + 1 < n; i += 1) {
    const d = Math.abs(((p[i * 2] ?? 0) - x0) * dz - ((p[i * 2 + 1] ?? 0) - z0) * dx) / len;

    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }

  if (maxD <= eps) {
    return [x0, z0, x1, z1];
  }

  const l = rdp(p.slice(0, maxI * 2 + 2), eps);
  const r = rdp(p.slice(maxI * 2), eps);

  return [...l.slice(0, -2), ...r];
};

const pLen = (p: readonly number[]) => {
  let L = 0;

  for (let i = 2; i < p.length; i += 2) {
    L += Math.hypot((p[i] ?? 0) - (p[i - 2] ?? 0), (p[i + 1] ?? 0) - (p[i - 1] ?? 0));
  }

  return L;
};

const spliceAtNode = (e1: RawEdge, e2: RawEdge, n: number) => {
  const p1 = e1.b === n ? e1.p : reversePts(e1.p);
  const a = e1.b === n ? e1.a : e1.b;
  const p2 = e2.a === n ? e2.p : reversePts(e2.p);
  const b = e2.a === n ? e2.b : e2.a;

  if (a === b) {
    return null;
  }

  return { a, b, p: [...p1, ...p2.slice(2)], w: Math.max(e1.w, e2.w) };
};

const contractDegree2 = (edges: readonly RawEdge[], degree: ReadonlyMap<number, number>) => {
  let live: (RawEdge | null)[] = [...edges];
  let merged = true;

  while (merged) {
    merged = false;
    const byNode = new Map<number, number[]>();

    for (const [i, e] of live.entries()) {
      if (!e) {
        continue;
      }

      for (const n of [e.a, e.b]) {
        const arr = byNode.get(n) ?? [];
        arr.push(i);
        byNode.set(n, arr);
      }
    }

    for (const [n, idxs] of byNode) {
      if (degree.get(n) !== 2 || idxs.length !== 2) {
        continue;
      }

      const [i1, i2] = idxs;

      if (i1 === undefined || i2 === undefined || i1 === i2) {
        continue;
      }

      const e1 = live[i1];
      const e2 = live[i2];

      if (!e1 || !e2 || e1.a === e1.b || e2.a === e2.b) {
        continue;
      }

      const spliced = spliceAtNode(e1, e2, n);

      if (!spliced) {
        continue;
      }

      live[i1] = spliced;
      live[i2] = null;
      merged = true;
    }

    if (merged) {
      live = live.filter((e) => e !== null);
    }
  }

  return live;
};

const fuseJunctionClusters = (input: readonly (RawEdge | null)[], nodes: [number, number][]) => {
  let live = [...input];
  let contracted = true;

  while (contracted) {
    contracted = false;

    for (let i = 0; i < live.length; i += 1) {
      const e = live[i];

      if (!e || e.a === e.b) {
        continue;
      }

      if (pLen(e.p) >= ROAD_TILE * 1.45) {
        continue;
      }

      const keep = e.a;
      const drop = e.b;
      const ka = nodes[keep];
      const kb = nodes[drop];

      if (!ka || !kb) {
        continue;
      }

      nodes[keep] = [(ka[0] + kb[0]) / 2, (ka[1] + kb[1]) / 2];

      for (let j = 0; j < live.length; j += 1) {
        const f = live[j];

        if (!f) {
          continue;
        }

        if (f.a === drop || f.b === drop) {
          live[j] = { ...f, a: f.a === drop ? keep : f.a, b: f.b === drop ? keep : f.b };
        }
      }

      live[i] = null;
      contracted = true;
    }

    if (contracted) {
      live = live.filter((e) => e !== null);
    }
  }

  return live;
};

const snapAndSimplify = (
  live: readonly (RawEdge | null)[],
  nodes: readonly (readonly [number, number])[],
) => {
  const out: RawEdge[] = [];

  for (const e of live) {
    if (!e) {
      continue;
    }

    if (e.a === e.b && pLen(e.p) < 45) {
      continue;
    }

    const na = nodes[e.a];
    const nb = nodes[e.b];

    if (!na || !nb) {
      continue;
    }

    const [nax, naz] = na;
    const [nbx, nbz] = nb;
    const p = [...e.p];
    p[0] = nax;
    p[1] = naz;
    p[p.length - 2] = nbx;
    p[p.length - 1] = nbz;
    const smoothed = chaikin(rdp(p, ROAD_TILE * 0.38));

    if (pLen(smoothed) < 2) {
      continue;
    }

    out.push({ ...e, p: smoothed });
  }

  return out;
};

export const buildGridNetwork = (
  plan: CityPlan,
  worldX: (gx: number) => number,
  worldZ: (gz: number) => number,
) => {
  const nodes: [number, number][] = [];
  const nodeAt = new Map<string, number>();

  const isRoad = (gx: number, gz: number) =>
    gx >= 0 && gz >= 0 && gx < plan.sizeX && gz < plan.sizeZ && plan.cells[gx]?.[gz] === "road";

  const isNode = (gx: number, gz: number) => {
    const road = plan.roads[gx]?.[gz];

    if (!road) {
      return false;
    }

    return road.kind !== "straight";
  };

  const nodeId = (gx: number, gz: number) => {
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
  const walked = new Set<string>();

  const walk = (gx: number, gz: number, dir: Dir) => {
    const k = `${gx},${gz},${dir}`;

    if (walked.has(k)) {
      return;
    }

    walked.add(k);
    const [dx, dz] = DIR_DELTA[dir];

    if (!isRoad(gx + dx, gz + dz)) {
      return;
    }

    const a = nodeId(gx, gz);
    let cx = gx + dx;
    let cz = gz + dz;
    let steps = 1;

    while (!isNode(cx, cz) && steps < 10_000) {
      cx += dx;
      cz += dz;
      steps += 1;

      if (!isRoad(cx, cz)) {
        return;
      }
    }

    const back = OPPOSITE_DIR[dir];
    walked.add(`${cx},${cz},${back}`);
    const b = nodeId(cx, cz);

    if (a === b && steps < 2) {
      return;
    }

    let majors = 0;
    let total = 0;

    for (let step = 0; step <= steps; step += 1) {
      if (majorMaskAt(gx + dx * step, gz + dz * step)) {
        majors += 1;
      }

      total += 1;
    }

    edges.push({
      a,
      b,
      p: [worldX(gx), worldZ(gz), worldX(cx), worldZ(cz)],
      w: majors > total * 0.5 ? MAJOR_ROAD_HALF : TILE_ROAD_HALF,
    });
  };

  for (let gx = 0; gx < plan.sizeX; gx += 1) {
    for (let gz = 0; gz < plan.sizeZ; gz += 1) {
      if (!isNode(gx, gz)) {
        continue;
      }

      walk(gx, gz, N);
      walk(gx, gz, E);
      walk(gx, gz, S);
      walk(gx, gz, W);
    }
  }

  const degree = new Map<number, number>();

  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }

  const contracted = contractDegree2(edges, degree);
  const fused = fuseJunctionClusters(contracted, nodes);

  return { edges: snapAndSimplify(fused, nodes), nodes };
};
