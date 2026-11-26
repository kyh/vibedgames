import { SF_EDGES, SF_NODES } from "./sf-network";
import type { RawEdge } from "./sf-network";

export interface EdgeSample {
  readonly x: number;
  readonly z: number;
  readonly tx: number;
  readonly tz: number;
}

export interface NetEdge {
  readonly id: number;
  readonly a: number;
  readonly b: number;
  readonly half: number;
  readonly pts: Float32Array;
  readonly cum: Float32Array;
  readonly len: number;
}

export interface NearestHit {
  readonly edge: NetEdge;
  readonly s: number;
  readonly dist: number;
  readonly tx: number;
  readonly tz: number;
  readonly x: number;
  readonly z: number;
}

const HASH_CELL = 40;

interface Arm {
  readonly tx: number;
  readonly tz: number;
  readonly half: number;
}

const buildEdges = (rawEdges: readonly (RawEdge | undefined)[]) => {
  const edges: NetEdge[] = [];

  for (const [i, raw] of rawEdges.entries()) {
    if (!raw) {
      continue;
    }

    const pts = new Float32Array(raw.p);
    const n = pts.length / 2;
    const cum = new Float32Array(n);

    for (let k = 1; k < n; k += 1) {
      const dx = (pts[k * 2] ?? 0) - (pts[k * 2 - 2] ?? 0);
      const dz = (pts[k * 2 + 1] ?? 0) - (pts[k * 2 - 1] ?? 0);
      cum[k] = (cum[k - 1] ?? 0) + Math.hypot(dx, dz);
    }

    edges.push({ a: raw.a, b: raw.b, cum, half: raw.w, id: i, len: cum[n - 1] ?? 0, pts });
  }

  return edges;
};

const nodeArms = (n: number, ids: readonly number[], byId: ReadonlyMap<number, NetEdge>) => {
  const arms: Arm[] = [];

  for (const id of ids) {
    const e = byId.get(id);

    if (!e) {
      continue;
    }

    const m = e.pts.length / 2;

    if (m < 2) {
      continue;
    }

    if (e.a === n) {
      const dx = (e.pts[2] ?? 0) - (e.pts[0] ?? 0);
      const dz = (e.pts[3] ?? 0) - (e.pts[1] ?? 0);
      const l = Math.hypot(dx, dz) || 1;
      arms.push({ half: e.half, tx: dx / l, tz: dz / l });
    }

    if (e.b === n) {
      const dx = (e.pts[m * 2 - 4] ?? 0) - (e.pts[m * 2 - 2] ?? 0);
      const dz = (e.pts[m * 2 - 3] ?? 0) - (e.pts[m * 2 - 1] ?? 0);
      const l = Math.hypot(dx, dz) || 1;
      arms.push({ half: e.half, tx: dx / l, tz: dz / l });
    }
  }

  return arms;
};

const junctionTrim = (arms: readonly Arm[]) => {
  let trim = 0;

  for (const a of arms) {
    trim = Math.max(trim, a.half * 1.15);
  }

  for (let i = 0; i < arms.length; i += 1) {
    for (let j = i + 1; j < arms.length; j += 1) {
      const a = arms[i];
      const b = arms[j];

      if (!a || !b) {
        continue;
      }

      const dot = Math.min(1, Math.max(-1, a.tx * b.tx + a.tz * b.tz));
      const halfAngle = Math.acos(dot) / 2;

      if (halfAngle < 0.02) {
        continue;
      }

      const d = (a.half + b.half) / (2 * Math.sin(halfAngle));
      trim = Math.max(trim, Math.min(d, 14));
    }
  }

  return Math.min(trim, 14);
};

const hashSegments = (edges: readonly NetEdge[]) => {
  const buckets = new Map<string, number[]>();

  for (const e of edges) {
    const seen = new Set<string>();

    for (let k = 0; k + 2 < e.pts.length; k += 2) {
      const x0 = Math.min(e.pts[k] ?? 0, e.pts[k + 2] ?? 0);
      const x1 = Math.max(e.pts[k] ?? 0, e.pts[k + 2] ?? 0);
      const z0 = Math.min(e.pts[k + 1] ?? 0, e.pts[k + 3] ?? 0);
      const z1 = Math.max(e.pts[k + 1] ?? 0, e.pts[k + 3] ?? 0);

      for (let bx = Math.floor(x0 / HASH_CELL); bx <= Math.floor(x1 / HASH_CELL); bx += 1) {
        for (let bz = Math.floor(z0 / HASH_CELL); bz <= Math.floor(z1 / HASH_CELL); bz += 1) {
          const key = `${bx},${bz}`;

          if (seen.has(key)) {
            continue;
          }

          seen.add(key);
          const list = buckets.get(key);

          if (list) {
            list.push(e.id);
          } else {
            buckets.set(key, [e.id]);
          }
        }
      }
    }
  }

  return buckets;
};

export class RoadNetwork {
  readonly nodes: readonly (readonly [number, number])[];
  readonly edges: readonly NetEdge[];
  readonly nodeEdges: readonly (readonly number[])[];
  readonly maxNodeTrim: number;
  private readonly nodeTrims: Float32Array;
  private readonly passThrough: Uint8Array;
  private readonly buckets: Map<string, number[]>;

  constructor(
    nodes: readonly (readonly [number, number])[] = SF_NODES,
    rawEdges: readonly (RawEdge | undefined)[] = SF_EDGES,
  ) {
    this.nodes = nodes;
    const edges = buildEdges(rawEdges);
    this.edges = edges;

    const nodeEdges: number[][] = nodes.map(() => []);

    for (const e of edges) {
      nodeEdges[e.a]?.push(e.id);
      nodeEdges[e.b]?.push(e.id);
    }

    this.nodeEdges = nodeEdges;

    const byId = new Map<number, NetEdge>();

    for (const e of edges) {
      byId.set(e.id, e);
    }

    const trims = new Float32Array(nodes.length);
    const passThrough = new Uint8Array(nodes.length);

    for (let n = 0; n < nodes.length; n += 1) {
      const arms = nodeArms(n, nodeEdges[n] ?? [], byId);

      if (arms.length === 0) {
        continue;
      }

      trims[n] = junctionTrim(arms);

      if (arms.length === 2) {
        const [a, b] = arms;

        if (a && b && a.tx * b.tx + a.tz * b.tz < -0.8) {
          passThrough[n] = 1;
        }
      }
    }

    this.nodeTrims = trims;
    this.passThrough = passThrough;
    let maxTrim = 0;

    for (const trim of trims) {
      maxTrim = Math.max(maxTrim, trim);
    }

    this.maxNodeTrim = maxTrim;
    this.buckets = hashSegments(edges);
  }

  // oxlint-disable-next-line class-methods-use-this -- instance API every consumer calls on its network
  sample(e: NetEdge, s: number) {
    const cs = Math.min(Math.max(s, 0), e.len);
    const n = e.pts.length / 2;
    let k = 1;

    while (k < n - 1 && (e.cum[k] ?? 0) < cs) {
      k += 1;
    }

    const s0 = e.cum[k - 1] ?? 0;
    const s1 = e.cum[k] ?? 0;
    const t = s1 > s0 ? (cs - s0) / (s1 - s0) : 0;
    const ax = e.pts[k * 2 - 2] ?? 0;
    const az = e.pts[k * 2 - 1] ?? 0;
    const bx = e.pts[k * 2] ?? 0;
    const bz = e.pts[k * 2 + 1] ?? 0;
    const dl = Math.hypot(bx - ax, bz - az) || 1;

    return {
      tx: (bx - ax) / dl,
      tz: (bz - az) / dl,
      x: ax + (bx - ax) * t,
      z: az + (bz - az) * t,
    };
  }

  nodeTrim(node: number) {
    return this.nodeTrims[node] ?? 0;
  }

  nodeIsPassThrough(node: number) {
    return this.passThrough[node] === 1;
  }

  /**
   * Every edge with a segment bucketed within `r` of a point, deduped. A
   * caller that asks `nearest` for many points in one neighbourhood (the
   * parcel plan: ~40 queries per parcel over 147k parcels) fetches this once
   * and answers the rest against the subset — the bucket walk and its string
   * keys were most of that pass's time.
   */
  edgesWithin(x: number, z: number, r: number) {
    const out: NetEdge[] = [];
    const n = Math.ceil(r / HASH_CELL);
    const cbx = Math.floor(x / HASH_CELL);
    const cbz = Math.floor(z / HASH_CELL);
    const seen = new Set<number>();

    for (let bx = cbx - n; bx <= cbx + n; bx += 1) {
      for (let bz = cbz - n; bz <= cbz + n; bz += 1) {
        for (const id of this.buckets.get(`${bx},${bz}`) ?? []) {
          if (seen.has(id)) {
            continue;
          }

          seen.add(id);
          const e = this.edges[id];

          if (e) {
            out.push(e);
          }
        }
      }
    }

    return out;
  }

  nearest(x: number, z: number, maxDist: number) {
    let best: NearestHit | null = null;
    let bd = maxDist * maxDist;
    const r = Math.ceil(maxDist / HASH_CELL);
    const cbx = Math.floor(x / HASH_CELL);
    const cbz = Math.floor(z / HASH_CELL);
    const tried = new Set<number>();

    for (let bx = cbx - r; bx <= cbx + r; bx += 1) {
      for (let bz = cbz - r; bz <= cbz + r; bz += 1) {
        for (const id of this.buckets.get(`${bx},${bz}`) ?? []) {
          if (tried.has(id)) {
            continue;
          }

          tried.add(id);
          const e = this.edges[id];

          if (!e) {
            continue;
          }

          for (let k = 0; k + 2 < e.pts.length; k += 2) {
            const ax = e.pts[k] ?? 0;
            const az = e.pts[k + 1] ?? 0;
            const bx2 = e.pts[k + 2] ?? 0;
            const bz2 = e.pts[k + 3] ?? 0;
            const dx = bx2 - ax;
            const dz = bz2 - az;
            const l2 = dx * dx + dz * dz;

            const t =
              l2 > 1e-8 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / l2, 0), 1) : 0;

            const px = ax + dx * t;
            const pz = az + dz * t;
            const d2 = (px - x) * (px - x) + (pz - z) * (pz - z);

            if (d2 < bd) {
              bd = d2;
              const dl = Math.sqrt(l2) || 1;
              best = {
                dist: Math.sqrt(d2),
                edge: e,
                s: (e.cum[k / 2] ?? 0) + dl * t,
                tx: dx / dl,
                tz: dz / dl,
                x: px,
                z: pz,
              };
            }
          }
        }
      }
    }

    return best;
  }
}
