// Street-graph routing for the playtest navigator: A* over the baked road
// network, flattened to one polyline the pilot can follow. A straight bearing
// to the fare lies in a city grid — the route is what the streets allow.
import type { NearestHit, NetEdge, RoadNetwork } from "../world/network";

export interface Route {
  /** [x0,z0, x1,z1, ...] from the car's street to the target itself. */
  readonly pts: Float64Array;
  /** Arclength at each point. */
  readonly cum: Float64Array;
  readonly length: number;
}

export interface RouteFix {
  /** Arclength of the closest route point. */
  readonly s: number;
  /** Distance from the route, world units. */
  readonly offset: number;
}

export interface RoutePoint {
  readonly x: number;
  readonly z: number;
}

/** The streets and the hills they climb. */
export interface RouteWorld {
  readonly network: RoadNetwork;
  readonly heightAt: (x: number, z: number) => number;
}

const SNAP_RADIUS = 120;
// Slope gravity (40 × grade) beats the engine (20) at a grade of 0.5, and the
// car crawls well before that: steep streets are one-way, downhill.
const UNCLIMBABLE_GRADE = 0.3;
const UNCLIMBABLE_COST = 12;
const CLIMB_COST = 5;
const GRADE_STEP = 16;

interface Grades {
  readonly up: number;
  readonly down: number;
}

// Terrain never changes under a network, so grades outlive any one plan.
const gradeCache = new WeakMap<RoadNetwork, Map<number, Grades>>();
// What turning round costs, in street units: a route that starts behind the
// car has to beat one that starts ahead by this much.
const U_TURN_COST = 90;
// How close to a kerbside fare the route ends: inside both trigger radii
// (4.8 / 5.4) with margin, and short of the parked cars along the kerb.
const STOP_SHORT = 3.2;

class MinHeap {
  private readonly ids: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    let i = this.ids.length;
    this.ids.push(id);
    this.keys.push(key);
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if ((this.keys[parent] ?? 0) <= key) {
        break;
      }
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number | undefined {
    const [top] = this.ids;
    const lastId = this.ids.pop();
    const lastKey = this.keys.pop();
    if (this.ids.length > 0 && lastId !== undefined && lastKey !== undefined) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      this.sink();
    }
    return top;
  }

  private sink(): void {
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < this.ids.length && (this.keys[l] ?? 0) < (this.keys[m] ?? 0)) {
        m = l;
      }
      if (r < this.ids.length && (this.keys[r] ?? 0) < (this.keys[m] ?? 0)) {
        m = r;
      }
      if (m === i) {
        return;
      }
      this.swap(i, m);
      i = m;
    }
  }

  private swap(a: number, b: number): void {
    const id = this.ids[a] ?? 0;
    const key = this.keys[a] ?? 0;
    this.ids[a] = this.ids[b] ?? 0;
    this.keys[a] = this.keys[b] ?? 0;
    this.ids[b] = id;
    this.keys[b] = key;
  }
}

/** Points of `e` between arclengths `from` and `to` (either order), endpoints included. */
const slice = (net: RoadNetwork, e: NetEdge, from: number, to: number, out: number[]): void => {
  const a = net.sample(e, from);
  out.push(a.x, a.z);
  const n = e.pts.length / 2;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const inner: number[] = [];
  for (let k = 0; k < n; k += 1) {
    const s = e.cum[k] ?? 0;
    if (s > lo + 0.01 && s < hi - 0.01) {
      inner.push(k);
    }
  }
  if (to < from) {
    inner.reverse();
  }
  for (const k of inner) {
    out.push(e.pts[k * 2] ?? 0, e.pts[k * 2 + 1] ?? 0);
  }
  const b = net.sample(e, to);
  out.push(b.x, b.z);
};

const finish = (flat: readonly number[]): Route => {
  // Drop coincident points: a zero-length segment has no heading.
  const kept: number[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const x = flat[i] ?? 0;
    const z = flat[i + 1] ?? 0;
    const n = kept.length;
    if (n >= 2 && Math.hypot(x - (kept[n - 2] ?? 0), z - (kept[n - 1] ?? 0)) < 0.05) {
      continue;
    }
    kept.push(x, z);
  }
  const pts = new Float64Array(kept);
  const cum = new Float64Array(pts.length / 2);
  for (let k = 1; k < cum.length; k += 1) {
    cum[k] =
      (cum[k - 1] ?? 0) +
      Math.hypot(
        (pts[k * 2] ?? 0) - (pts[k * 2 - 2] ?? 0),
        (pts[k * 2 + 1] ?? 0) - (pts[k * 2 - 1] ?? 0),
      );
  }
  return { cum, length: cum.at(-1) ?? 0, pts };
};

interface Search {
  /** The goal edge's end the shortest path arrives at. */
  readonly end: number;
  /** Edge each node was reached by; the start edge's ends have none. */
  readonly cameBy: ReadonlyMap<number, NetEdge>;
}

/** A* from both ends of the start edge to either end of the goal edge. */
const search = (
  world: RouteWorld,
  start: NearestHit,
  goal: NearestHit,
  facing: number,
): Search | null => {
  const net = world.network;
  let grades = gradeCache.get(net);
  if (!grades) {
    grades = new Map();
    gradeCache.set(net, grades);
  }
  const cache = grades;
  /** Steepest stretch of `e` in each direction: a hill is local, an edge is a block. */
  const gradesOf = (e: NetEdge): Grades => {
    const known = cache.get(e.id);
    if (known) {
      return known;
    }
    let up = 0;
    let down = 0;
    let prev = net.sample(e, 0);
    let prevY = world.heightAt(prev.x, prev.z);
    for (let s = GRADE_STEP; s < e.len + GRADE_STEP; s += GRADE_STEP) {
      const at = net.sample(e, s);
      const y = world.heightAt(at.x, at.z);
      const run = Math.hypot(at.x - prev.x, at.z - prev.z);
      if (run > 1) {
        up = Math.max(up, (y - prevY) / run);
        down = Math.max(down, (prevY - y) / run);
      }
      prev = at;
      prevY = y;
    }
    const found = { down, up };
    cache.set(e.id, found);
    return found;
  };
  /** Cost of `len` units of edge `e` driven towards its node `to`. */
  const climb = (e: NetEdge, to: number, len: number): number => {
    const { up, down } = gradesOf(e);
    const grade = e.b === to ? up : down;
    if (grade > UNCLIMBABLE_GRADE) {
      return len * UNCLIMBABLE_COST;
    }
    return len * (1 + CLIMB_COST * grade);
  };
  const dist = new Map<number, number>();
  const cameBy = new Map<number, NetEdge>();
  const heap = new MinHeap();
  const done = new Set<number>();
  const h = (node: number): number => {
    const p = net.nodes[node];
    return p ? Math.hypot(p[0] - goal.x, p[1] - goal.z) : 0;
  };
  const goalCost = (node: number): number => {
    if (node === goal.edge.a) {
      return climb(goal.edge, goal.edge.b, goal.s);
    }
    return node === goal.edge.b ? climb(goal.edge, goal.edge.a, goal.edge.len - goal.s) : Infinity;
  };
  const reach = (node: number, cost: number, by: NetEdge | null): void => {
    if (cost >= (dist.get(node) ?? Infinity)) {
      return;
    }
    dist.set(node, cost);
    if (by) {
      cameBy.set(node, by);
    }
    heap.push(node, cost + h(node));
  };
  const toA = climb(start.edge, start.edge.a, start.s);
  const toB = climb(start.edge, start.edge.b, start.edge.len - start.s);
  reach(start.edge.a, toA + (facing > 0 ? U_TURN_COST : 0), null);
  reach(start.edge.b, toB + (facing > 0 ? 0 : U_TURN_COST), null);
  let end = -1;
  let best = Infinity;
  while (heap.size > 0) {
    const node = heap.pop();
    if (node === undefined || done.has(node)) {
      continue;
    }
    done.add(node);
    const d = dist.get(node) ?? Infinity;
    if (d + h(node) >= best) {
      break;
    }
    if (d + goalCost(node) < best) {
      best = d + goalCost(node);
      end = node;
    }
    for (const id of net.nodeEdges[node] ?? []) {
      const e = net.edges[id];
      if (e) {
        const next = e.a === node ? e.b : e.a;
        reach(next, d + climb(e, next, e.len), e);
      }
    }
  }
  return end < 0 ? null : { cameBy, end };
};

/**
 * Shortest street route from a car at (fx,fz) facing `heading` to the fare at
 * (tx,tz). The last point leaves the centreline towards the fare — they stand
 * on the kerb, which on a wide street is outside the trigger radius of a car
 * that only follows the centreline.
 */
export const planRoute = (
  world: RouteWorld,
  fx: number,
  fz: number,
  heading: number,
  fareX: number,
  fareZ: number,
): Route | null => {
  const net = world.network;
  const start = net.nearest(fx, fz, SNAP_RADIUS);
  const goal = net.nearest(fareX, fareZ, SNAP_RADIUS);
  if (!start || !goal) {
    return null;
  }
  const reach = goal.dist > STOP_SHORT ? (goal.dist - STOP_SHORT) / goal.dist : 0;
  const tx = goal.x + (fareX - goal.x) * reach;
  const tz = goal.z + (fareZ - goal.z) * reach;
  const flat: number[] = [fx, fz];
  // Positive when the car faces the start edge's a→b direction.
  const facing = Math.sin(heading) * start.tx + Math.cos(heading) * start.tz;
  const ahead = (goal.s - start.s) * facing > 0;
  if (start.edge.id === goal.edge.id && (ahead || Math.abs(goal.s - start.s) < U_TURN_COST)) {
    slice(net, start.edge, start.s, goal.s, flat);
    flat.push(tx, tz);
    return finish(flat);
  }
  const found = search(world, start, goal, facing);
  if (!found) {
    return null;
  }
  const legs: { edge: NetEdge; forward: boolean }[] = [];
  let node = found.end;
  for (let e = found.cameBy.get(node); e; e = found.cameBy.get(node)) {
    const forward = e.b === node;
    legs.push({ edge: e, forward });
    node = forward ? e.a : e.b;
  }
  legs.reverse();
  slice(net, start.edge, start.s, node === start.edge.a ? 0 : start.edge.len, flat);
  for (const leg of legs) {
    slice(net, leg.edge, leg.forward ? 0 : leg.edge.len, leg.forward ? leg.edge.len : 0, flat);
  }
  slice(net, goal.edge, found.end === goal.edge.a ? 0 : goal.edge.len, goal.s, flat);
  flat.push(tx, tz);
  return finish(flat);
};

/** Closest point of the route to (x,z), searched forward from arclength `from`. */
export const locate = (route: Route, x: number, z: number, from: number): RouteFix => {
  const n = route.cum.length;
  let bestS = from;
  let bestD = Infinity;
  for (let k = 0; k + 1 < n; k += 1) {
    const s1 = route.cum[k + 1] ?? 0;
    if (s1 < from - 20) {
      continue;
    }
    const s0 = route.cum[k] ?? 0;
    if (s0 > from + 80 && bestD < Infinity) {
      break;
    }
    const ax = route.pts[k * 2] ?? 0;
    const az = route.pts[k * 2 + 1] ?? 0;
    const dx = (route.pts[k * 2 + 2] ?? 0) - ax;
    const dz = (route.pts[k * 2 + 3] ?? 0) - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-9 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (d < bestD) {
      bestD = d;
      bestS = s0 + (s1 - s0) * t;
    }
  }
  return { offset: bestD, s: bestS };
};

/** The route point at arclength `s` (clamped). */
export const pointAt = (route: Route, s: number): RoutePoint => {
  const n = route.cum.length;
  const cs = Math.min(Math.max(s, 0), route.length);
  let k = 1;
  while (k < n - 1 && (route.cum[k] ?? 0) < cs) {
    k += 1;
  }
  const s0 = route.cum[k - 1] ?? 0;
  const s1 = route.cum[k] ?? 0;
  const t = s1 > s0 ? (cs - s0) / (s1 - s0) : 0;
  const ax = route.pts[k * 2 - 2] ?? 0;
  const az = route.pts[k * 2 - 1] ?? 0;
  return {
    x: ax + ((route.pts[k * 2] ?? 0) - ax) * t,
    z: az + ((route.pts[k * 2 + 1] ?? 0) - az) * t,
  };
};

/** Route bearing (atan2(dx,dz), the car's heading convention) at arclength `s`. */
export const bearingAt = (route: Route, s: number): number => {
  // Anchored short of the end so the last metres still have a direction.
  const from = Math.max(0, Math.min(s, route.length - 3));
  const a = pointAt(route, from);
  const b = pointAt(route, from + 3);
  return Math.atan2(b.x - a.x, b.z - a.z);
};
