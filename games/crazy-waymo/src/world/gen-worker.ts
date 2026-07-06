import * as THREE from "three";

import { CUSTOM_MAP } from "./custom-map";
import { generateCity } from "./grid";
import { buildGridNetwork } from "./grid-network";
import { makeGroundColorAt, makeGroundOffset } from "./ground";
import { RoadNetwork } from "./network";
import { buildRoadParts, type RoadPartBuffers } from "./roads";
import { makeTerrain } from "./sf-map";
import { GRID_X, GRID_Z, ROAD_TILE } from "../shared/constants";

// City-gen worker: the pure-math world (streets planar map + draped terrain)
// generates OFF the main thread, in parallel with the model download. The
// main thread receives transferable buffers and only uploads them to the GPU.
// Local editor overrides never apply here (worker location has no ?editor=1,
// and edited cities skip the worker entirely on the main thread).

export type TilePayload = {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array | null;
  index: Uint16Array | Uint32Array | null; // PlaneGeometry is indexed
  x: number;
  z: number;
};

export type CityGenPayload = {
  roadParts: RoadPartBuffers[];
  tiles: TilePayload[];
};

function run(): void {
  const t0 = performance.now();
  const plan = generateCity();
  // Mirror the main thread's network choice for canonical (unedited) cities.
  const baked = CUSTOM_MAP.add.length > 0 || CUSTOM_MAP.remove.length > 0;
  const worldX = (gx: number): number => (gx + 0.5) * ROAD_TILE - (GRID_X * ROAD_TILE) / 2;
  const worldZ = (gz: number): number => (gz + 0.5) * ROAD_TILE - (GRID_Z * ROAD_TILE) / 2;
  const network = baked
    ? (() => {
        const raw = buildGridNetwork(plan, worldX, worldZ);
        return new RoadNetwork(raw.nodes, raw.edges);
      })()
    : new RoadNetwork();
  const terrain = makeTerrain();

  const roadParts = buildRoadParts(network, terrain);

  const groundStub = new THREE.MeshBasicMaterial();
  const ground = terrain.buildMesh(
    groundStub,
    makeGroundColorAt(plan, terrain),
    makeGroundOffset(network),
  );
  const tiles: TilePayload[] = [];
  for (const tile of ground.children) {
    if (!(tile instanceof THREE.Mesh)) continue;
    const pos = tile.geometry.getAttribute("position");
    const nor = tile.geometry.getAttribute("normal");
    const col = tile.geometry.getAttribute("color");
    const idx = tile.geometry.index;
    tiles.push({
      position: pos.array as Float32Array,
      normal: nor.array as Float32Array,
      color: col ? (col.array as Float32Array) : null,
      index: idx ? (idx.array as Uint16Array | Uint32Array) : null,
      x: tile.position.x,
      z: tile.position.z,
    });
  }

  const payload: CityGenPayload = { roadParts, tiles };
  const transfer: ArrayBuffer[] = [];
  for (const p of roadParts) {
    transfer.push(p.position.buffer as ArrayBuffer, p.normal.buffer as ArrayBuffer);
    if (p.uv) transfer.push(p.uv.buffer as ArrayBuffer);
  }
  for (const t of tiles) {
    transfer.push(t.position.buffer as ArrayBuffer, t.normal.buffer as ArrayBuffer);
    if (t.color) transfer.push(t.color.buffer as ArrayBuffer);
    if (t.index) transfer.push(t.index.buffer as ArrayBuffer);
  }
  console.log(`[gen-worker] world built in ${Math.round(performance.now() - t0)}ms`);
  postMessage(payload, { transfer });
}

run();
