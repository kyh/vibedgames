import { BufferAttribute, BufferGeometry } from "three";
import type { CityRestPayload } from "../src/world/city";
import { packGeometry } from "../src/world/quantized-geometry";
import { deserializeWorldBin, unpackRest, unpackWorld, WORLD_REV } from "../src/world/world-bin";
import { packRest, packWorld, serializeWorldBin } from "../src/world/world-bin-pack";

type Check = (name: string, condition: boolean, detail?: string) => void;

/**
 * Packed geometry rides the decoded download as views — a tile IS its
 * geometry, and phones drop the arrays once the GPU has them — while the
 * raw geometries (BatchedMesh templates, Float32 by contract) own compact
 * copies so a small surviving mesh cannot pin a whole artifact.
 */
export const checkWorldBufferOwnership = async (check: Check): Promise<void> => {
  const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = [new Uint16Array([0, 1, 2]), new Uint32Array([2, 1, 0]), null];
  const mat = {
    color: 0xff_ff_ff,
    metalness: 0,
    opacity: 1,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
    roughness: 1,
    transparent: false,
    vertexColors: false,
  };
  const rawGeos = indices.map((index) => ({
    index,
    mat,
    normal: null,
    // Large vertex count retains Uint32 encoding through the packer.
    position: index instanceof Uint32Array ? new Float32Array(65_536 * 3) : position,
    uv: null,
  }));
  const packedGeos = indices.map((index) => {
    const geo = new BufferGeometry();
    geo.setAttribute(
      "position",
      new BufferAttribute(
        index instanceof Uint32Array ? new Float32Array(65_536 * 3) : position,
        3,
      ),
    );
    if (index) {
      geo.setIndex(new BufferAttribute(index, 1));
    }
    return packGeometry(geo);
  });
  const rest: CityRestPayload = {
    batchItems: [],
    decks: [],
    lampHeads: [],
    mergedChunks: packedGeos.map((geo) => ({ cx: 0, cz: 0, dist: 500, mat, srcMat: null, ...geo })),
    parkedCars: [],
    rawGeos,
    solids: [],
  };
  const world = {
    roadParts: [],
    tiles: packedGeos.map((geo) => ({ x: 0, z: 0, ...geo })),
  };
  const packed = serializeWorldBin({
    rest: packRest(rest),
    rev: WORLD_REV,
    world: packWorld(world),
  });
  const backing = new ArrayBuffer(packed.byteLength);
  new Uint8Array(backing).set(packed);
  const decoded = deserializeWorldBin(backing);
  if (!decoded.world || !decoded.rest) {
    throw new Error("Missing round-trip payload");
  }
  const runtimeWorld = unpackWorld(decoded.world);
  const runtimeRest = await unpackRest(decoded.rest);
  for (const [name, group] of [
    ["tiles", runtimeWorld.tiles],
    ["merged chunks", runtimeRest.mergedChunks],
  ] as const) {
    check(
      `packed ${name} stay views on the decoded artifact`,
      group.every(
        ({ index, pos }) =>
          pos.q.buffer === backing && (index === null || index.buffer === backing),
      ),
    );
    check(
      `packed ${name} preserve index width and missing indices`,
      group[0]?.index instanceof Uint16Array &&
        group[1]?.index instanceof Uint32Array &&
        group[2]?.index === null &&
        group[0]?.pos.q.length === 9,
    );
  }
  check(
    "raw geometries own compact indices",
    runtimeRest.rawGeos.every(
      ({ index }) =>
        index === null ||
        (index.buffer !== backing && index.buffer.byteLength === index.byteLength),
    ),
  );
  // Detaching models collection/transfer of the source. Raw copies survive it.
  structuredClone(backing, { transfer: [backing] });
  check(
    "raw geometries survive releasing the packed backing",
    runtimeRest.rawGeos[0]?.index?.[2] === 2 &&
      runtimeRest.rawGeos[1]?.index?.[0] === 2 &&
      runtimeRest.rawGeos[0]?.position.length === 9,
  );
};
