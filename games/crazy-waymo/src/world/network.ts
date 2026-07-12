import { type RawEdge, SF_EDGES, SF_NODES } from "./sf-network";

// Runtime view of the baked vector road network — THE source of truth for
// road rendering, traffic routing and building alignment. Edges are world-
// space polylines with arclength tables; a segment spatial hash answers
// nearest-edge queries (building setback, spawn snapping) in O(bucket).
// Park-interior streets are already clipped at bake time — no runtime filter.

export type EdgeSample = {
  readonly x: number;
  readonly z: number;
  readonly tx: number; // unit tangent (a→b direction)
  readonly tz: number;
};

export type NetEdge = {
  readonly id: number;
  readonly a: number;
  readonly b: number;
  readonly half: number; // asphalt half-width
  readonly pts: Float32Array; // [x0,z0, x1,z1, ...]
  readonly cum: Float32Array; // arclength at each point
  readonly len: number;
};

export type NearestHit = {
  readonly edge: NetEdge;
  readonly s: number; // arclength along the edge
  readonly dist: number;
  readonly tx: number;
  readonly tz: number;
  readonly x: number; // closest point on the edge
  readonly z: number;
};

const HASH_CELL = 40; // world units per bucket

export class RoadNetwork {
  readonly nodes: readonly (readonly [number, number])[];
  readonly edges: readonly NetEdge[];
  readonly nodeEdges: readonly (readonly number[])[]; // node → incident edge ids
  readonly maxNodeTrim: number; // largest nodeTrim in the network (clip-radius bound)
  private nodeTrims: Float32Array;
  private passThrough: Uint8Array; // 1 = two near-collinear arms (not a real junction)
  private buckets = new Map<string, number[]>(); // "bx,bz" → edge ids (deduped)

  constructor(
    nodes: readonly (readonly [number, number])[] = SF_NODES,
    rawEdges: readonly (RawEdge | undefined)[] = SF_EDGES,
  ) {
    this.nodes = nodes;
    const edges: NetEdge[] = [];
    for (let i = 0; i < rawEdges.length; i++) {
      const raw = rawEdges[i];
      if (!raw) continue;
      const pts = new Float32Array(raw.p);
      const n = pts.length / 2;
      const cum = new Float32Array(n);
      for (let k = 1; k < n; k++) {
        const dx = (pts[k * 2] ?? 0) - (pts[k * 2 - 2] ?? 0);
        const dz = (pts[k * 2 + 1] ?? 0) - (pts[k * 2 - 1] ?? 0);
        cum[k] = (cum[k - 1] ?? 0) + Math.hypot(dx, dz);
      }
      edges.push({ id: i, a: raw.a, b: raw.b, half: raw.w, pts, cum, len: cum[n - 1] ?? 0 });
    }
    this.edges = edges;

    const nodeEdges: number[][] = nodes.map(() => []);
    for (const e of edges) {
      nodeEdges[e.a]?.push(e.id);
      nodeEdges[e.b]?.push(e.id);
    }
    this.nodeEdges = nodeEdges;

    // Per-node junction clearance. The old maxHalf*1.15 only knows the widest
    // arm — at multi-arm shallow-angle nodes (Market meeting the grid) the
    // merged asphalt extends far beyond that, so paint and strips poked into
    // the junction. Two strips separated by angle θ stop overlapping at
    // d = (h1+h2) / (2·sin(θ/2)) along each arm; take the worst pair, capped.
    const byId = new Map<number, NetEdge>();
    for (const e of edges) byId.set(e.id, e);
    const trims = new Float32Array(nodes.length);
    const passThrough = new Uint8Array(nodes.length);
    for (let n = 0; n < nodes.length; n++) {
      const ids = nodeEdges[n] ?? [];
      if (ids.length === 0) continue;
      const arms: { tx: number; tz: number; half: number }[] = [];
      for (const id of ids) {
        const e = byId.get(id);
        if (!e) continue;
        const m = e.pts.length / 2;
        if (m < 2) continue;
        if (e.a === n) {
          const dx = (e.pts[2] ?? 0) - (e.pts[0] ?? 0);
          const dz = (e.pts[3] ?? 0) - (e.pts[1] ?? 0);
          const l = Math.hypot(dx, dz) || 1;
          arms.push({ tx: dx / l, tz: dz / l, half: e.half });
        }
        if (e.b === n) {
          const dx = (e.pts[m * 2 - 4] ?? 0) - (e.pts[m * 2 - 2] ?? 0);
          const dz = (e.pts[m * 2 - 3] ?? 0) - (e.pts[m * 2 - 1] ?? 0);
          const l = Math.hypot(dx, dz) || 1;
          arms.push({ tx: dx / l, tz: dz / l, half: e.half });
        }
      }
      let trim = 0;
      for (const a of arms) trim = Math.max(trim, a.half * 1.15);
      for (let i = 0; i < arms.length; i++) {
        for (let j = i + 1; j < arms.length; j++) {
          const a = arms[i];
          const b = arms[j];
          if (!a || !b) continue;
          const dot = Math.min(1, Math.max(-1, a.tx * b.tx + a.tz * b.tz));
          const halfAngle = Math.acos(dot) / 2;
          if (halfAngle < 0.02) continue; // duplicate/parallel arm — cap would explode
          const d = (a.half + b.half) / (2 * Math.sin(halfAngle));
          trim = Math.max(trim, Math.min(d, 20));
        }
      }
      trims[n] = Math.min(trim, 20);
      if (arms.length === 2) {
        const a = arms[0];
        const b = arms[1];
        if (a && b && a.tx * b.tx + a.tz * b.tz < -0.8) passThrough[n] = 1;
      }
    }
    this.nodeTrims = trims;
    this.passThrough = passThrough;
    let maxTrim = 0;
    for (let n = 0; n < trims.length; n++) maxTrim = Math.max(maxTrim, trims[n] ?? 0);
    this.maxNodeTrim = maxTrim;

    // Spatial hash: every segment registers in the buckets its AABB spans.
    for (const e of edges) {
      const seen = new Set<string>();
      for (let k = 0; k + 2 < e.pts.length; k += 2) {
        const x0 = Math.min(e.pts[k] ?? 0, e.pts[k + 2] ?? 0);
        const x1 = Math.max(e.pts[k] ?? 0, e.pts[k + 2] ?? 0);
        const z0 = Math.min(e.pts[k + 1] ?? 0, e.pts[k + 3] ?? 0);
        const z1 = Math.max(e.pts[k + 1] ?? 0, e.pts[k + 3] ?? 0);
        for (let bx = Math.floor(x0 / HASH_CELL); bx <= Math.floor(x1 / HASH_CELL); bx++) {
          for (let bz = Math.floor(z0 / HASH_CELL); bz <= Math.floor(z1 / HASH_CELL); bz++) {
            const key = `${bx},${bz}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const list = this.buckets.get(key);
            if (list) list.push(e.id);
            else this.buckets.set(key, [e.id]);
          }
        }
      }
    }
  }

  // Point + tangent at arclength s (clamped to [0, len]).
  sample(e: NetEdge, s: number): EdgeSample {
    const cs = Math.min(Math.max(s, 0), e.len);
    const n = e.pts.length / 2;
    let k = 1;
    while (k < n - 1 && (e.cum[k] ?? 0) < cs) k++;
    const s0 = e.cum[k - 1] ?? 0;
    const s1 = e.cum[k] ?? 0;
    const t = s1 > s0 ? (cs - s0) / (s1 - s0) : 0;
    const ax = e.pts[k * 2 - 2] ?? 0;
    const az = e.pts[k * 2 - 1] ?? 0;
    const bx = e.pts[k * 2] ?? 0;
    const bz = e.pts[k * 2 + 1] ?? 0;
    const dl = Math.hypot(bx - ax, bz - az) || 1;
    return {
      x: ax + (bx - ax) * t,
      z: az + (bz - az) * t,
      tx: (bx - ax) / dl,
      tz: (bz - az) / dl,
    };
  }

  // Junction clearance at a node: swept edge strips stop this far short so
  // the junction disc owns the overlap area. Angle-aware (see constructor).
  nodeTrim(node: number): number {
    return this.nodeTrims[node] ?? 0;
  }

  // Two near-collinear arms: a polyline joint mid-street, not a junction —
  // paint may run straight through (clipping it would gap solid edge lines).
  nodeIsPassThrough(node: number): boolean {
    return this.passThrough[node] === 1;
  }

  // Nearest point on the network within maxDist (via the segment hash).
  nearest(x: number, z: number, maxDist: number): NearestHit | null {
    let best: NearestHit | null = null;
    let bd = maxDist * maxDist;
    const r = Math.ceil(maxDist / HASH_CELL);
    const cbx = Math.floor(x / HASH_CELL);
    const cbz = Math.floor(z / HASH_CELL);
    const tried = new Set<number>();
    for (let bx = cbx - r; bx <= cbx + r; bx++) {
      for (let bz = cbz - r; bz <= cbz + r; bz++) {
        for (const id of this.buckets.get(`${bx},${bz}`) ?? []) {
          if (tried.has(id)) continue;
          tried.add(id);
          const e = this.edges[id];
          if (!e) continue;
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
                edge: e,
                s: (e.cum[k / 2] ?? 0) + dl * t,
                dist: Math.sqrt(d2),
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
