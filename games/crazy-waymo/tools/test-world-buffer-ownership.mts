import type { CityRestPayload } from "../src/world/city";
import { deserializeWorldBin, unpackRest, unpackWorld, WORLD_REV } from "../src/world/world-bin";
import { packRest, packWorld, serializeWorldBin } from "../src/world/world-bin-pack";

type Check = (name: string, condition: boolean, detail?: string) => void;

/** Runtime geometry must survive releasing the large decoded download buffer. */
export async function checkWorldBufferOwnership(check: Check): Promise<void> {
  const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = [new Uint16Array([0, 1, 2]), new Uint32Array([2, 1, 0]), null];
  const mat = {
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    vertexColors: false,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
    transparent: false,
    opacity: 1,
  };
  const rawGeos = indices.map((index) => ({
    // Large vertex count retains Uint32 encoding through the packer.
    position: index instanceof Uint32Array ? new Float32Array(65536 * 3) : position,
    normal: null,
    uv: null,
    index,
    mat,
  }));
  const rest: CityRestPayload = {
    rawGeos,
    mergedChunks: rawGeos.map((geo) => ({
      ...geo,
      cx: 0,
      cz: 0,
      dist: 500,
      color: null,
      srcMat: null,
    })),
    batchItems: [],
    solids: [],
    parkedCars: [],
    lampHeads: [],
    decks: [],
  };
  const world = {
    roadParts: [],
    tiles: indices.map((index) => ({ position, normal: null, color: null, index, x: 0, z: 0 })),
  };
  const packed = serializeWorldBin({
    rev: WORLD_REV,
    world: packWorld(world),
    rest: packRest(rest),
  });
  const backing = new ArrayBuffer(packed.byteLength);
  new Uint8Array(backing).set(packed);
  const decoded = deserializeWorldBin(backing);
  if (!decoded.world || !decoded.rest) throw new Error("Missing round-trip payload");
  const runtimeWorld = unpackWorld(decoded.world);
  const runtimeRest = await unpackRest(decoded.rest);
  const groups = [runtimeWorld.tiles, runtimeRest.mergedChunks, runtimeRest.rawGeos];
  for (const [i, group] of groups.entries()) {
    check(
      `runtime buffer group ${i} owns compact indices`,
      group.every(
        ({ index }) =>
          index === null ||
          (index.buffer !== backing && index.buffer.byteLength === index.byteLength),
      ),
    );
    check(
      `runtime buffer group ${i} preserves index width and missing indices`,
      group[0]?.index instanceof Uint16Array &&
        group[1]?.index instanceof Uint32Array &&
        group[2]?.index === null,
    );
  }
  // Detaching models collection/transfer of the source. A retained view becomes empty.
  structuredClone(backing, { transfer: [backing] });
  check(
    "runtime geometry survives releasing packed backing",
    groups.every(
      (group) =>
        group[0]?.index?.[2] === 2 && group[1]?.index?.[0] === 2 && group[0]?.position.length === 9,
    ),
  );
}
