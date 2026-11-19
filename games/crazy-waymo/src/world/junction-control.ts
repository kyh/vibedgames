import type { RoadNetwork } from "./network";

export type JunctionControl = "none" | "signal" | "stop";

const hash01 = (n: number, salt: number) => {
  /* oxlint-disable no-bitwise -- integer hash mixing */
  let h = (n * 2_654_435_761 + salt * 340_573_321) >>> 0;
  h ^= h >>> 16;
  h = (h * 2_246_822_519) >>> 0;
  h ^= h >>> 13;

  return (h >>> 0) / 4_294_967_296;
  /* oxlint-enable no-bitwise */
};

export interface ControlArm {
  readonly tx: number;
  readonly tz: number;
  readonly half: number;
  readonly px: number;
  readonly pz: number;
}

export const controlArms = (network: RoadNetwork, node: number) => {
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

export const junctionControl: (network: RoadNetwork, node: number) => JunctionControl = (
  network,
  node,
) => {
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

  if (boulevards === 0 && arms.length <= 4 && network.nodeTrim(node) < 9 && hash01(node, 3) < 0.5) {
    return "stop";
  }

  return "none";
};

export const SIGNAL_CYCLE_S = 12;

export const signalAxisIsX = (tx: number, tz: number) => Math.abs(tx) > Math.abs(tz);

export const signalGreen = (node: number, tx: number, tz: number, t: number) => {
  const offset = hash01(node, 4) * SIGNAL_CYCLE_S;
  const phase = (t + offset) % SIGNAL_CYCLE_S < SIGNAL_CYCLE_S / 2;

  return signalAxisIsX(tx, tz) === phase;
};
