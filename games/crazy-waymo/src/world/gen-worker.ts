import * as THREE from "three";

import { CUSTOM_MAP } from "./custom-map";
import { generateCity } from "./grid";
import { buildGridNetwork } from "./grid-network";
import { makeGroundColorAt, makeGroundOffset, makeTerracedDrapeField } from "./ground";
import { RoadNetwork } from "./network";
import { buildRoadParts } from "./roads";
import type { RoadPartBuffers } from "./roads";
import { makeTerrain } from "./sf-map";
import { packGeometry } from "./quantized-geometry";
import type { PackedTile } from "./world-bin";
import { GRID_X, GRID_Z, ROAD_TILE } from "../shared/constants";

// City-gen worker: the pure-math world (streets planar map + draped terrain)
// generates OFF the main thread, in parallel with the model download. The
// main thread receives transferable buffers and only uploads them to the GPU.
// Local editor overrides never apply here (worker location has no ?editor=1,
// and edited cities skip the worker entirely on the main thread).

export interface CityGenPayload {
  roadParts: RoadPartBuffers[];
  /** Terrain tiles, quantized at the source (world/quantized-geometry.ts). */
  tiles: PackedTile[];
}

const worldX = (gx: number): number => (gx + 0.5) * ROAD_TILE - (GRID_X * ROAD_TILE) / 2;
const worldZ = (gz: number): number => (gz + 0.5) * ROAD_TILE - (GRID_Z * ROAD_TILE) / 2;

// SAFETY: every payload TypedArray was allocated in this worker over a plain
// ArrayBuffer (never a SharedArrayBuffer); `.buffer` only widens to
// ArrayBufferLike.
const transferable = (
  view: Float32Array | Uint16Array | Uint32Array | Int8Array | Uint8Array,
): ArrayBuffer => view.buffer as ArrayBuffer;

const run = (): void => {
  const t0 = performance.now();
  const plan = generateCity();
  // Mirror the main thread's network choice for canonical (unedited) cities.
  const baked = CUSTOM_MAP.add.length > 0 || CUSTOM_MAP.remove.length > 0;
  const network = baked
    ? (() => {
        const raw = buildGridNetwork(plan, worldX, worldZ);
        return new RoadNetwork(raw.nodes, raw.edges);
      })()
    : new RoadNetwork();
  const terrain = makeTerrain();

  // Roads drape onto terrain + the step-ladder street terrace — the same
  // field the ground offset below and the runtime drive surface report.
  const roadParts = buildRoadParts(network, makeTerracedDrapeField(network, terrain));

  const groundStub = new THREE.MeshBasicMaterial();
  const ground = terrain.buildMesh(
    groundStub,
    makeGroundColorAt(plan, terrain),
    makeGroundOffset(network, terrain),
  );
  const tiles: PackedTile[] = [];
  for (const tile of ground.children) {
    if (!(tile instanceof THREE.Mesh)) {
      continue;
    }
    tiles.push({ ...packGeometry(tile.geometry), x: tile.position.x, z: tile.position.z });
  }

  const payload: CityGenPayload = { roadParts, tiles };
  const transfer: ArrayBuffer[] = [];
  for (const p of roadParts) {
    transfer.push(transferable(p.position), transferable(p.normal));
    if (p.uv) {
      transfer.push(transferable(p.uv));
    }
    if (p.index) {
      transfer.push(transferable(p.index));
    }
  }
  for (const t of tiles) {
    transfer.push(transferable(t.pos.q), transferable(t.nor));
    if (t.col) {
      transfer.push(transferable(t.col));
    }
    if (t.uv) {
      transfer.push(transferable(t.uv.q));
    }
    if (t.index) {
      transfer.push(transferable(t.index));
    }
  }
  console.log(`[gen-worker] world built in ${Math.round(performance.now() - t0)}ms`);
  postMessage(payload, { transfer });
};

run();
