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
import { isMesh } from "../shared/three-guards";

export interface CityGenPayload {
  roadParts: RoadPartBuffers[];
  /** Terrain tiles, quantized at the source (world/quantized-geometry.ts). */
  tiles: PackedTile[];
}

const worldX = (gx: number) => (gx + 0.5) * ROAD_TILE - (GRID_X * ROAD_TILE) / 2;
const worldZ = (gz: number) => (gz + 0.5) * ROAD_TILE - (GRID_Z * ROAD_TILE) / 2;

const transferable = (view: Float32Array | Uint16Array | Uint32Array | Int8Array | Uint8Array) => {
  const { buffer } = view;

  if (!(buffer instanceof ArrayBuffer)) {
    throw new TypeError("gen-worker: a shared buffer cannot be transferred");
  }

  return buffer;
};

const run = () => {
  const t0 = performance.now();
  const plan = generateCity();
  const baked = CUSTOM_MAP.add.length > 0 || CUSTOM_MAP.remove.length > 0;

  const network = baked
    ? (() => {
        const raw = buildGridNetwork(plan, worldX, worldZ);

        return new RoadNetwork(raw.nodes, raw.edges);
      })()
    : new RoadNetwork();

  const terrain = makeTerrain();

  const roadParts = buildRoadParts(network, makeTerracedDrapeField(network, terrain));

  const groundStub = new THREE.MeshBasicMaterial();

  const ground = terrain.buildMesh(
    groundStub,
    makeGroundColorAt(plan, terrain),
    makeGroundOffset(network, terrain),
  );

  const tiles: PackedTile[] = [];

  for (const tile of ground.children) {
    if (!isMesh(tile)) {
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
