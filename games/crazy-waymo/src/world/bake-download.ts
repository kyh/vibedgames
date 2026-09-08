import { CHUNK, WORLD_HALF_X, WORLD_HALF_Z, WORLD_W, WORLD_H } from "../shared/constants";
import type { CityModel } from "./city";
import type { CityGenPayload } from "./gen-worker";
import { packLots, packPlans } from "./parcel-pack";
import type { ParcelLot, ParcelPlan } from "./parcel-plan";
import {
  type BakeFile,
  type PackedMeta,
  type PackedMergedChunk,
  type PackedWorldTile,
  WORLD_REV,
  type WorldTileRef,
} from "./world-bin";
import { packRest, packSolids, packWorld, serializeWorldBin } from "./world-bin-pack";
import type { Solid } from "../shared/types";

// ?bake=1: download the world artifacts for public/world/ as ONE file —
// world.bin (terrain), meta.bin (batches, solids, skyline, tile index) and a
// tile per 320u cell (its merged geometry + parcel fabric), each gzipped.
// Run on a COLD dev build so the capture reflects the current pipeline.
// Lazy-loaded (dynamic import) behind the param — tools/bake-world.mjs
// drives this headlessly, waits on the [bake] console lines + the
// world-bake.bin download and unpacks the container, so keep both as they are.

const NX = Math.ceil(WORLD_W / CHUNK);
const NZ = Math.ceil(WORLD_H / CHUNK);

const tileIndex = (x: number, z: number): readonly [number, number] => [
  Math.min(NX - 1, Math.max(0, Math.floor((x + WORLD_HALF_X) / CHUNK))),
  Math.min(NZ - 1, Math.max(0, Math.floor((z + WORLD_HALF_Z) / CHUNK))),
];

type TileDraft = {
  readonly ix: number;
  readonly iz: number;
  readonly mergedChunks: PackedMergedChunk[];
  readonly plans: ParcelPlan[];
  readonly lots: ParcelLot[];
  readonly solids: Solid[];
};

export async function downloadWorldArtifacts(
  bakePayload: CityGenPayload | null,
  city: CityModel,
): Promise<void> {
  const rest = city.restCapture;
  const parcels = city.parcelCapture;
  if (!bakePayload || !rest || !parcels) {
    throw new Error("World bake is incomplete: terrain, city and parcel captures are all required");
  }
  const gzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const stream = new Blob([new Uint8Array(bytes)])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  const files: BakeFile[] = [];

  console.log("[bake] packing world…");
  files.push({
    name: "world.bin",
    data: await gzip(serializeWorldBin({ rev: WORLD_REV, world: packWorld(bakePayload) })),
  });

  console.log("[bake] packing tiles…");
  const drafts = new Map<number, TileDraft>();
  const draftAt = (x: number, z: number): TileDraft => {
    const [ix, iz] = tileIndex(x, z);
    const key = ix * 1024 + iz;
    let d = drafts.get(key);
    if (!d) {
      d = { ix, iz, mergedChunks: [], plans: [], lots: [], solids: [] };
      drafts.set(key, d);
    }
    return d;
  };
  for (const rec of rest.mergedChunks) draftAt(rec.cx, rec.cz).mergedChunks.push(rec);
  for (const p of parcels.fabric) draftAt(p.obb.cx, p.obb.cz).plans.push(p);
  for (const l of parcels.lots) draftAt(l.obb.cx, l.obb.cz).lots.push(l);
  for (const p of parcels.all) draftAt(p.obb.cx, p.obb.cz).solids.push(...p.solids);
  const refs: WorldTileRef[] = [];
  for (const d of [...drafts.values()].sort((a, b) => a.iz - b.iz || a.ix - b.ix)) {
    const tile: PackedWorldTile = {
      ix: d.ix,
      iz: d.iz,
      cx: (d.ix + 0.5) * CHUNK - WORLD_HALF_X,
      cz: (d.iz + 0.5) * CHUNK - WORLD_HALF_Z,
      mergedChunks: d.mergedChunks,
      plans: packPlans(d.plans),
      lots: packLots(d.lots),
      solids: packSolids(d.solids),
    };
    const data = await gzip(serializeWorldBin({ rev: WORLD_REV, tile }));
    files.push({ name: `tiles/${d.ix}_${d.iz}.bin`, data });
    refs.push({ ix: d.ix, iz: d.iz, cx: tile.cx, cz: tile.cz, bytes: data.byteLength });
  }

  console.log("[bake] packing meta…");
  // The rest capture's solids are the base set (copied before the parcel
  // pass — its walls went to the tiles above); the parked cars come from the
  // city after it, so the lot cars are in them.
  const packed = packRest({
    ...rest,
    mergedChunks: [],
    parkedCars: [...city.parkedCarSpecs],
  });
  const meta: PackedMeta = {
    rawGeos: packed.rawGeos,
    items: packed.items,
    solids: packed.solids,
    parkedCars: packed.parkedCars,
    lampHeads: packed.lampHeads,
    decks: packed.decks,
    skyline: packPlans(parcels.skyline),
    tiles: refs,
  };
  files.push({
    name: "meta.bin",
    data: await gzip(serializeWorldBin({ rev: WORLD_REV, meta })),
  });

  const total = files.reduce((a, f) => a + f.data.byteLength, 0);
  console.log(`[bake] ${files.length} artifacts, ${total} bytes gzipped — downloading container…`);
  const container = serializeWorldBin({ rev: WORLD_REV, files });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([new Uint8Array(container)]));
  a.download = "world-bake.bin";
  a.click();
  console.log(
    "[bake] artifacts downloaded — tools/bake-world.mjs installs them into public/world/",
  );
}
