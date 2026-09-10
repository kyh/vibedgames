import type { RoadNetwork } from "./network";

// THE single source of truth for junction control — which nodes are
// signalized, which run all-way stops, and when each signal is green.
// Pure functions of (network, node): furniture.ts places the matching
// hardware at bake time and traffic.ts obeys it at runtime, so the two can
// never disagree (the old furniture warrant rolled the shared rng stream,
// which traffic could not replay).

export type JunctionControl = "none" | "signal" | "stop";

// Deterministic per-node hash in [0, 1) — replaces rng.chance in warrants.
const hash01 = (n: number, salt: number): number => {
  /* oxlint-disable no-bitwise -- integer hash mixing */
  let h = (n * 2_654_435_761 + salt * 340_573_321) >>> 0;
  h ^= h >>> 16;
  h = (h * 2_246_822_519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4_294_967_296;
  /* oxlint-enable no-bitwise */
};

export interface ControlArm {
  // outward tangent (away from the node)
  readonly tx: number;
  readonly tz: number;
  readonly half: number;
  // centreline trim point
  readonly px: number;
  readonly pz: number;
}

// Edge-end arms meeting at a node (trim-point geometry shared by furniture
// placement, crosswalk paint and the traffic hold points).
export const controlArms = (network: RoadNetwork, node: number): ControlArm[] => {
  const arms: ControlArm[] = [];
  for (const id of network.nodeEdges[node] ?? []) {
    const edge = network.edges[id];
    if (!edge) {
      continue;
    }
    const ends: ("a" | "b")[] = [];
    if (edge.a === node) {
      ends.push("a");
    }
    if (edge.b === node) {
      ends.push("b");
    }
    for (const end of ends) {
      const trim = Math.min(network.nodeTrim(node), edge.len * 0.45);
      const s0 = end === "a" ? trim : edge.len - trim;
      const smp = network.sample(edge, s0);
      const sign = end === "a" ? 1 : -1;
      arms.push({ half: edge.half, px: smp.x, pz: smp.z, tx: smp.tx * sign, tz: smp.tz * sign });
    }
  }
  return arms;
};

// Real-SF control hierarchy: arterial-arterial crossings get signals,
// arterial-minor gets a sprinkle of signals, and the minor grid runs on
// all-way stop signs (THE San Francisco junction).
export const junctionControl = (network: RoadNetwork, node: number): JunctionControl => {
  const ids = network.nodeEdges[node];
  if (!ids || ids.length < 3) {
    return "none";
  }
  if (network.nodeIsPassThrough(node)) {
    return "none";
  }
  const arms = controlArms(network, node);
  let boulevards = 0;
  for (const a of arms) {
    if (a.half > 4.7) {
      boulevards += 1;
    }
  }
  if (
    boulevards >= 2 ||
    (boulevards >= 1 && arms.length >= 3 && hash01(node, 1) < 0.4) ||
    (arms.length >= 4 && hash01(node, 2) < 0.08)
  ) {
    return "signal";
  }
  // All-way stop: minor 3/4-way junctions. Mega-blob nodes skip — their
  // trims put the "corner" mid-blob and traffic barely reads them as nodes.
  if (boulevards === 0 && arms.length <= 4 && network.nodeTrim(node) < 9 && hash01(node, 3) < 0.5) {
    return "stop";
  }
  return "none";
};

// --- Signal timing ---
// Two phases split by dominant axis: X-ish approaches vs Z-ish approaches.
// A fixed city-wide cycle with a per-node offset (so the grid doesn't blink
// in lockstep); no clearance interval — arcade traffic brakes hard enough.
// full cycle: half green X, half green Z
export const SIGNAL_CYCLE_S = 12;

export const signalAxisIsX = (tx: number, tz: number): boolean => Math.abs(tx) > Math.abs(tz);

// Green for the approach travelling along (tx, tz) at time t (seconds)?
export const signalGreen = (node: number, tx: number, tz: number, t: number): boolean => {
  const offset = hash01(node, 4) * SIGNAL_CYCLE_S;
  const phase = (t + offset) % SIGNAL_CYCLE_S < SIGNAL_CYCLE_S / 2;
  return signalAxisIsX(tx, tz) === phase;
};
