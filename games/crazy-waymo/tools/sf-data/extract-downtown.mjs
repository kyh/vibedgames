// Extract game data from the licensed "Downtown San Francisco" OBJ
// (OSM-derived: buildings grouped by height tag, roads by highway class).
//
//   node tools/sf-data/extract-downtown.mjs <path-to-obj>
//
// Pass 1: stream the OBJ; collect vertices, per-group faces.
// Buildings: groups aggregate many buildings per height tag — split each
// group into connected components over shared vertices; each component is
// one building (footprint bbox + height).
// Roads: vertex clouds for the drivable classes, for calibration + checks.
// Output: downtown-raw.json (model-space) — calibrate-downtown.mjs maps it
// into world space.

import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const objPath = process.argv[2];
if (!objPath) {
  console.error("usage: node extract-downtown.mjs <obj>");
  process.exit(1);
}

const ROAD_RE = /^highway_(motorway|trunk|primary|secondary|tertiary|residential|unclassified)(_link)?(_|$)/;

const vx = [];
const vy = [];
const vz = [];
let curGroup = null;
let curMtl = "";
// group name -> { faces: number[][] (vertex ids), mtl }
const buildingGroups = new Map();
const roadVerts = []; // [x, z] samples of drivable-road geometry
let roadVertBudget = 0;

const rl = createInterface({ input: createReadStream(objPath), crlfDelay: Infinity });
rl.on("line", (l) => {
  const c0 = l.charCodeAt(0);
  if (c0 === 118 /* v */ && l.charCodeAt(1) === 32) {
    let i = 2;
    while (l.charCodeAt(i) === 32) i++;
    const j = l.indexOf(" ", i);
    const k = l.indexOf(" ", j + 1);
    vx.push(Number(l.slice(i, j)));
    vy.push(Number(l.slice(j + 1, k)));
    vz.push(Number(l.slice(k + 1)));
  } else if (c0 === 102 /* f */) {
    if (!curGroup) return;
    const isRoad = ROAD_RE.test(curGroup);
    const isBuilding = curMtl === "building";
    if (!isRoad && !isBuilding) return;
    const ids = [];
    for (const part of l.slice(2).trim().split(/\s+/)) {
      const s = part.indexOf("/") >= 0 ? part.slice(0, part.indexOf("/")) : part;
      let id = Number(s);
      if (id < 0) id = vx.length + 1 + id;
      ids.push(id - 1);
    }
    if (isBuilding) {
      let g = buildingGroups.get(curGroup);
      if (!g) {
        g = { faces: [] };
        buildingGroups.set(curGroup, g);
      }
      g.faces.push(ids);
    } else if (roadVertBudget++ % 3 === 0) {
      for (const id of ids) roadVerts.push([vx[id], vz[id]]);
    }
  } else if (l.startsWith("g ") || l.startsWith("o ")) {
    curGroup = l.slice(2).trim();
  } else if (l.startsWith("usemtl")) {
    curMtl = l.slice(7).trim();
  }
});

rl.on("close", () => {
  // --- Split building groups into connected components (one per building) ---
  const buildings = [];
  for (const [name, g] of buildingGroups) {
    // Union-find over the vertex ids used by this group.
    const parent = new Map();
    const find = (a) => {
      let r = a;
      while (parent.get(r) !== r) r = parent.get(r);
      while (parent.get(a) !== r) {
        const next = parent.get(a);
        parent.set(a, r);
        a = next;
      }
      return r;
    };
    const union = (a, b) => {
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const f of g.faces) {
      for (let i = 1; i < f.length; i++) union(f[0], f[i]);
    }
    const comps = new Map(); // root -> {minX..maxZ}
    for (const f of g.faces) {
      const root = find(f[0]);
      let c = comps.get(root);
      if (!c) {
        c = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, minZ: 1e9, maxZ: -1e9 };
        comps.set(root, c);
      }
      for (const id of f) {
        const x = vx[id];
        const y = vy[id];
        const z = vz[id];
        if (x < c.minX) c.minX = x;
        if (x > c.maxX) c.maxX = x;
        if (y < c.minY) c.minY = y;
        if (y > c.maxY) c.maxY = y;
        if (z < c.minZ) c.minZ = z;
        if (z > c.maxZ) c.maxZ = z;
      }
    }
    const tagged = name.match(/height=([0-9.]+)/);
    const tagH = tagged ? Number(tagged[1]) : null;
    for (const c of comps.values()) {
      const w = c.maxX - c.minX;
      const d = c.maxZ - c.minZ;
      if (w < 3 || d < 3) continue; // shed/antenna slivers
      buildings.push({
        x: Math.round(((c.minX + c.maxX) / 2) * 10) / 10,
        z: Math.round(((c.minZ + c.maxZ) / 2) * 10) / 10,
        w: Math.round(w * 10) / 10,
        d: Math.round(d * 10) / 10,
        h: Math.round((c.maxY - c.minY) * 10) / 10,
        tagH,
      });
    }
  }
  buildings.sort((a, b) => b.h - a.h);

  console.log(`buildings: ${buildings.length} (from ${buildingGroups.size} tag groups)`);
  console.log("tallest:", JSON.stringify(buildings.slice(0, 8)));
  console.log(`road samples: ${roadVerts.length}`);

  writeFileSync(
    new URL("./downtown-raw.json", import.meta.url),
    JSON.stringify({ buildings, roadVerts: roadVerts.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]) }),
  );
  console.log("downtown-raw.json written");
});
