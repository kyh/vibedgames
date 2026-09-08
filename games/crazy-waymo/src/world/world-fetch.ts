import type { CityGenPayload } from "./gen-worker";
import { deserializeWorldBin, unpackMeta, unpackWorld, WORLD_REV } from "./world-bin";
import type { CityRestMeta, PackedWorldTile, WorldBinPayload, WorldTileRef } from "./world-bin";
import { PARCEL_SOURCE_VERSION } from "./parcel-source";

// Loader for the pre-baked world shipped as static assets (public/world/,
// gzipped by the bake). First visits skip ALL generation: world.bin (terrain)
// and meta.bin (batches, solids, skyline, tile index) come first; the city's
// static geometry and parcel fabric arrive per 320u tile, nearest first
// (world/world-tiles.ts), so a phone downloads its neighbourhood, not the map.

async function gunzip(gz: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream("gzip");
  return await new Response(new Blob([gz]).stream().pipeThrough(ds)).arrayBuffer();
}

// The artifacts are served immutable (1yr browser cache) from unversioned
// paths — the rev query is what lets a rebake reach returning players.
const bust = (path: string): string => `${path}?v=${WORLD_REV}`;

async function fetchGz(path: string): Promise<ArrayBuffer | null> {
  const res = await fetch(bust(path));
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  // SPA fallbacks answer 200 with index.html — a real artifact is binary
  // and starts with the gzip magic bytes.
  const head = new Uint8Array(buf, 0, 2);
  return head[0] === 0x1f && head[1] === 0x8b ? buf : null;
}

async function fetchBin(path: string): Promise<WorldBinPayload | null> {
  try {
    const gz = await fetchGz(path);
    if (!gz) return null;
    const buf = await gunzip(gz);
    const data = deserializeWorldBin(buf);
    if (data.rev !== WORLD_REV) {
      console.log(`[world-bin] ${path} rev ${data.rev} != ${WORLD_REV} — ignoring`);
      return null;
    }
    console.log(`[world-bin] ${path} loaded`);
    return data;
  } catch (e) {
    console.log(
      `[world-bin] ${path} failed: ${e instanceof Error ? `${e.name}: ${e.message}` : e}`,
    );
    return null;
  }
}

export function fetchBakedWorld(): Promise<CityGenPayload | null> {
  return fetchBin("world/world.bin")
    .then((d) => (d?.world ? unpackWorld(d.world) : null))
    .catch((e) => {
      console.log(`[world-bin] world unpack failed: ${e instanceof Error ? e.message : e}`);
      return null;
    });
}

/** The untiled remainder of the built city, plus the tile index. */
export function fetchWorldMeta(): Promise<CityRestMeta | null> {
  return fetchBin("world/meta.bin")
    .then((d) => (d?.meta ? unpackMeta(d.meta) : null))
    .catch((e) => {
      console.log(`[world-bin] meta unpack failed: ${e instanceof Error ? e.message : e}`);
      return null;
    });
}

export const worldTilePath = (ref: WorldTileRef): string => `world/tiles/${ref.ix}_${ref.iz}.bin`;

/** One world tile. Null on any failure — the streamer retries on its next pass. */
export function fetchWorldTile(ref: WorldTileRef): Promise<PackedWorldTile | null> {
  return fetchBin(worldTilePath(ref))
    .then((d) => d?.tile ?? null)
    .catch((e) => {
      console.log(
        `[world-bin] tile ${ref.ix},${ref.iz} failed: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    });
}

/**
 * The parcel source (public/world/parcels.bin), inflated but not decoded —
 * the caller hands the bytes to the parcel worker. Versioned by its own
 * header, not WORLD_REV: it is an INPUT to generation, and a rebake of the
 * world does not change it. Null on any failure — the city then builds no
 * parcel fabric and the kit walk fills the blocks: a worse city, not a
 * broken one.
 */
export function fetchParcelSource(): Promise<ArrayBuffer | null> {
  return fetchGz("world/parcels.bin")
    .then(async (gz) => {
      if (!gz) return null;
      const buf = await gunzip(gz);
      console.log(
        `[world-bin] parcels.bin loaded: ${buf.byteLength} bytes (v${PARCEL_SOURCE_VERSION})`,
      );
      return buf;
    })
    .catch((e) => {
      console.log(`[world-bin] parcels.bin failed: ${e instanceof Error ? e.message : e}`);
      return null;
    });
}
