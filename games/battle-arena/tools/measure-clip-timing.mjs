// Measures combat-clip timing straight from the KayKit animation GLBs:
//   node tools/measure-clip-timing.mjs
// For every clip it reports { dur, contact } where `contact` is the fraction
// of the clip at which the right-hand weapon mount (handslot.r) hits PEAK
// world speed — a solid proxy for "the blade connects". The curated table the
// game ships lives in src/data/clip-timing.ts; re-run this after swapping
// animation packs and reconcile (a few low-hand-speed casts are hand-tuned
// there — see the OVERRIDE notes in that file).
import { readFileSync, readdirSync } from "node:fs";
import nodePath from "node:path";

const ANIM_DIR = nodePath.join(import.meta.dirname, "../public/models/animations");

// ── minimal GLB parse (JSON chunk + BIN chunk, float32 accessors) ──
const parseGlb = (path) => {
  const buf = readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf-8"));
  const bin = buf.subarray(20 + jsonLen + 8);
  return { bin, json };
};

const accessorData = ({ json, bin }, idx) => {
  const acc = json.accessors[idx];
  const bv = json.bufferViews[acc.bufferView];
  const compCount = { SCALAR: 1, VEC3: 3, VEC4: 4 }[acc.type];
  const byteOff = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  if (acc.componentType !== 5126) {
    throw new Error(`unsupported componentType ${acc.componentType}`);
  }
  return new Float32Array(bin.buffer, bin.byteOffset + byteOff, acc.count * compCount);
};

// ── math ──
const quatSlerp = (a, b, t) => {
  const [ax, ay, az, aw] = a;
  let [bx, by, bz, bw] = b;
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

const composeMat = (t, q, s) => {
  const [x, y, z, w] = q;
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
  const [sx, sy, sz] = s;
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
    t[0],
    t[1],
    t[2],
    1,
  ];
};

const mulMat = (a, b) => {
  const o = Array.from({ length: 16 }, () => 0);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      for (let k = 0; k < 4; k += 1) {
        o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
      }
    }
  }
  return o;
};

const sampleTrack = (times, values, comps, t, isQuat) => {
  const n = times.length;
  if (t <= times[0]) {
    return [...values.subarray(0, comps)];
  }
  if (t >= times[n - 1]) {
    return [...values.subarray((n - 1) * comps, n * comps)];
  }
  let i = 1;
  while (times[i] < t) {
    i += 1;
  }
  const t0 = times[i - 1];
  const t1 = times[i];
  const k = t1 - t0 > 0 ? (t - t0) / (t1 - t0) : 0;
  const a = [...values.subarray((i - 1) * comps, i * comps)];
  const b = [...values.subarray(i * comps, (i + 1) * comps)];
  return isQuat ? quatSlerp(a, b, k) : a.map((v, j) => v + (b[j] - v) * k);
};

const norm = (name) => name.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();

const analyze = (path) => {
  const glb = parseGlb(path);
  const { json } = glb;
  const { nodes } = json;
  const parent = Array.from({ length: nodes.length }, () => -1);
  for (const [i, n] of nodes.entries()) {
    for (const c of n.children ?? []) {
      parent[c] = i;
    }
  }
  const handIdx = nodes.findIndex((n) => norm(n.name ?? "") === "handslotr");
  if (handIdx === -1) {
    return {};
  }

  const results = {};
  for (const anim of json.animations ?? []) {
    const tracks = new Map();
    let dur = 0;
    for (const ch of anim.channels) {
      const s = anim.samplers[ch.sampler];
      const times = accessorData(glb, s.input);
      const values = accessorData(glb, s.output);
      dur = Math.max(dur, times.at(-1));
      if (!tracks.has(ch.target.node)) {
        tracks.set(ch.target.node, {});
      }
      tracks.get(ch.target.node)[ch.target.path] = { times, values };
    }
    if (dur === 0) {
      continue;
    }

    const STEPS = 120;
    const handPos = [];
    for (let step = 0; step <= STEPS; step += 1) {
      const t = (step / STEPS) * dur;
      const world = new Map();
      const worldOf = (idx) => {
        if (idx < 0) {
          return null;
        }
        if (world.has(idx)) {
          return world.get(idx);
        }
        const n = nodes[idx];
        const tr = tracks.get(idx);
        const T = tr?.translation
          ? sampleTrack(tr.translation.times, tr.translation.values, 3, t, false)
          : (n.translation ?? [0, 0, 0]);
        const R = tr?.rotation
          ? sampleTrack(tr.rotation.times, tr.rotation.values, 4, t, true)
          : (n.rotation ?? [0, 0, 0, 1]);
        const S = tr?.scale
          ? sampleTrack(tr.scale.times, tr.scale.values, 3, t, false)
          : (n.scale ?? [1, 1, 1]);
        const local = composeMat(T, R, S);
        const p = worldOf(parent[idx]);
        const m = p ? mulMat(p, local) : local;
        world.set(idx, m);
        return m;
      };
      const m = worldOf(handIdx);
      handPos.push([m[12], m[13], m[14]]);
    }

    let peakI = 0;
    let peakV = 0;
    for (let i = 1; i < handPos.length; i += 1) {
      const [ax, ay, az] = handPos[i - 1];
      const [bx, by, bz] = handPos[i];
      const v = Math.hypot(bx - ax, by - ay, bz - az) * (STEPS / dur);
      if (i > STEPS * 0.05 && i < STEPS * 0.97 && v > peakV) {
        peakV = v;
        peakI = i;
      }
    }
    results[anim.name] = {
      contact: Math.round((peakI / STEPS) * 100) / 100,
      dur: Math.round(dur * 1000) / 1000,
      // low (<5) → weak proxy, hand-tune
      peakHandSpeed: Math.round(peakV * 100) / 100,
    };
  }
  return results;
};

const out = {};
for (const f of readdirSync(ANIM_DIR)
  .filter((name) => name.endsWith(".glb"))
  .toSorted()) {
  const prefix = f.startsWith("Rig_Large") ? "Large/" : "";
  for (const [k, v] of Object.entries(analyze(nodePath.join(ANIM_DIR, f)))) {
    if (!(prefix + k in out)) {
      out[prefix + k] = v;
    }
  }
}
console.log(JSON.stringify(out, null, 2));
