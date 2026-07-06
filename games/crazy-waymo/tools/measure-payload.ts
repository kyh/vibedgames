import { buildRoadParts } from "./src/world/roads";
import { RoadNetwork } from "./src/world/network";
import { makeTerrain } from "./src/world/sf-map";
import { generateCity } from "./src/world/grid";
import { makeGroundColorAt, makeGroundOffset } from "./src/world/ground";
import * as THREE from "three";

const network = new RoadNetwork();
const terrain = makeTerrain();
const plan = generateCity();

const parts = buildRoadParts(network, terrain);
let roadBytes = 0, roadVerts = 0;
for (const p of parts) {
  roadBytes += p.position.byteLength + p.normal.byteLength + (p.uv?.byteLength ?? 0);
  roadVerts += p.position.length / 3;
}

const ground = terrain.buildMesh(new THREE.MeshBasicMaterial(), makeGroundColorAt(plan, terrain), makeGroundOffset(network));
let tileBytes = 0, tileVerts = 0;
for (const t of ground.children) {
  if (!(t instanceof THREE.Mesh)) continue;
  const g = t.geometry;
  for (const k of ["position", "normal", "color"]) {
    const a = g.getAttribute(k);
    if (a) tileBytes += (a.array as Float32Array).byteLength;
  }
  if (g.index) tileBytes += (g.index.array as Uint32Array).byteLength;
  tileVerts += g.getAttribute("position").count;
}
console.log(JSON.stringify({
  roadMB: +(roadBytes / 1e6).toFixed(1),
  roadVerts,
  tileMB: +(tileBytes / 1e6).toFixed(1),
  tileVerts,
  totalMB: +((roadBytes + tileBytes) / 1e6).toFixed(1),
}));
