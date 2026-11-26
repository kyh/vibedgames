import { readdirSync } from "node:fs";
import nodePath from "node:path";

import { NodeIO } from "@gltf-transform/core";
import type { Animation, Node, TypedArray } from "@gltf-transform/core";

type Vec = number[];

interface Track {
  times: TypedArray;
  values: TypedArray;
}

type NodeTracks = Partial<Record<"rotation" | "scale" | "translation", Track>>;

interface ClipTiming {
  contact: number;
  dur: number;
  peakHandSpeed: number;
}

const ANIM_DIR = nodePath.join(import.meta.dirname, "../public/models/animations");
const STEPS = 120;

const at = (values: ArrayLike<number>, i: number) => values[i] ?? 0;

const quatSlerp = (a: Vec, b: Vec, t: number) => {
  const [ax = 0, ay = 0, az = 0, aw = 1] = a;
  let [bx = 0, by = 0, bz = 0, bw = 1] = b;
  let dot = ax * bx + ay * by + az * bz + aw * bw;

  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }

  if (dot > 0.9995) {
    const q = [ax + t * (bx - ax), ay + t * (by - ay), az + t * (bz - az), aw + t * (bw - aw)];
    const l = Math.hypot(...q);

    return q.map((v) => v / l);
  }

  const th = Math.acos(dot);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;

  return [ax * wa + bx * wb, ay * wa + by * wb, az * wa + bz * wb, aw * wa + bw * wb];
};

const composeMat = (t: Vec, q: Vec, s: Vec) => {
  const [x = 0, y = 0, z = 0, w = 1] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const [sx = 1, sy = 1, sz = 1] = s;

  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    at(t, 0),
    at(t, 1),
    at(t, 2),
    1,
  ];
};

const mulMat = (a: Vec, b: Vec) =>
  Array.from({ length: 16 }, (_, i) => {
    const c = Math.floor(i / 4);
    const r = i % 4;

    return [0, 1, 2, 3].reduce((sum, k) => sum + at(a, k * 4 + r) * at(b, c * 4 + k), 0);
  });

const slice = (values: TypedArray, from: number, to: number) => [...values.subarray(from, to)];

const sampleTrack = ({ times, values }: Track, comps: number, t: number, isQuat: boolean) => {
  const n = times.length;

  if (t <= at(times, 0)) {
    return slice(values, 0, comps);
  }

  if (t >= at(times, n - 1)) {
    return slice(values, (n - 1) * comps, n * comps);
  }

  const i = Math.max(
    1,
    times.findIndex((time) => time >= t),
  );

  const t0 = at(times, i - 1);
  const t1 = at(times, i);
  const k = t1 - t0 > 0 ? (t - t0) / (t1 - t0) : 0;
  const a = slice(values, (i - 1) * comps, i * comps);
  const b = slice(values, i * comps, (i + 1) * comps);

  return isQuat ? quatSlerp(a, b, k) : a.map((v, j) => v + (at(b, j) - v) * k);
};

const norm = (name: string) => name.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();

const isTrackPath = (path: string | null): path is keyof NodeTracks =>
  path === "translation" || path === "rotation" || path === "scale";

const tracksOf = (anim: Animation) => {
  const tracks = new Map<Node, NodeTracks>();
  let dur = 0;

  for (const ch of anim.listChannels()) {
    const node = ch.getTargetNode();
    const targetPath = ch.getTargetPath();
    const sampler = ch.getSampler();
    const times = sampler?.getInput()?.getArray() ?? null;
    const values = sampler?.getOutput()?.getArray() ?? null;

    if (node === null || !isTrackPath(targetPath) || times === null || values === null) {
      continue;
    }

    dur = Math.max(dur, times.at(-1) ?? 0);
    const nodeTracks = tracks.get(node) ?? {};
    nodeTracks[targetPath] = { times, values };
    tracks.set(node, nodeTracks);
  }

  return { dur, tracks };
};

const handPath = (hand: Node, tracks: Map<Node, NodeTracks>, dur: number) =>
  Array.from({ length: STEPS + 1 }, (_, step) => {
    const t = (step / STEPS) * dur;
    const world = new Map<Node, Vec>();

    const worldOf: (node: Node) => Vec = (node) => {
      const known = world.get(node);

      if (known !== undefined) {
        return known;
      }

      const tr = tracks.get(node);

      const T = tr?.translation ? sampleTrack(tr.translation, 3, t, false) : node.getTranslation();

      const R = tr?.rotation ? sampleTrack(tr.rotation, 4, t, true) : node.getRotation();
      const S = tr?.scale ? sampleTrack(tr.scale, 3, t, false) : node.getScale();
      const local = composeMat(T, R, S);
      const parent = node.getParentNode();
      const m = parent === null ? local : mulMat(worldOf(parent), local);
      world.set(node, m);

      return m;
    };

    const m = worldOf(hand);

    return [at(m, 12), at(m, 13), at(m, 14)];
  });

const peakOf = (handPos: number[][], dur: number) => {
  let peakI = 0;
  let peakV = 0;

  for (let i = 1; i < handPos.length; i += 1) {
    const [ax = 0, ay = 0, az = 0] = handPos[i - 1] ?? [];
    const [bx = 0, by = 0, bz = 0] = handPos[i] ?? [];
    const v = Math.hypot(bx - ax, by - ay, bz - az) * (STEPS / dur);

    if (i > STEPS * 0.05 && i < STEPS * 0.97 && v > peakV) {
      peakV = v;
      peakI = i;
    }
  }

  return { peakI, peakV };
};

const analyze = async (io: NodeIO, path: string) => {
  const doc = await io.read(path);
  const root = doc.getRoot();
  const hand = root.listNodes().find((n) => norm(n.getName()) === "handslotr");
  const results: Record<string, ClipTiming> = {};

  if (hand === undefined) {
    return results;
  }

  for (const anim of root.listAnimations()) {
    const { dur, tracks } = tracksOf(anim);

    if (dur === 0) {
      continue;
    }

    const { peakI, peakV } = peakOf(handPath(hand, tracks, dur), dur);

    results[anim.getName()] = {
      contact: Math.round((peakI / STEPS) * 100) / 100,
      dur: Math.round(dur * 1000) / 1000,
      peakHandSpeed: Math.round(peakV * 100) / 100,
    };
  }

  return results;
};

const io = new NodeIO();

const files = readdirSync(ANIM_DIR)
  .filter((name) => name.endsWith(".glb"))
  .toSorted();

const analyses = await Promise.all(
  files.map(async (f) => await analyze(io, nodePath.join(ANIM_DIR, f))),
);

const out: Record<string, ClipTiming> = {};

for (const [i, f] of files.entries()) {
  const prefix = f.startsWith("Rig_Large") ? "Large/" : "";

  for (const [k, v] of Object.entries(analyses[i] ?? {})) {
    if (!(prefix + k in out)) {
      out[prefix + k] = v;
    }
  }
}

console.log(JSON.stringify(out, null, 2));
