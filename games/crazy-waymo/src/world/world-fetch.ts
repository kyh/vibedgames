import type { CityGenPayload } from "./gen-worker";
import { deserializeWorldBin, unpackMeta, unpackWorld, WORLD_REV } from "./world-bin";
import type { CityRestMeta, PackedWorldTile, WorldBinPayload, WorldTileRef } from "./world-bin";
import { PARCEL_SOURCE_VERSION } from "./parcel-source";

// Loader for the pre-baked world shipped as static assets (public/world/,
// gzipped by the bake). First visits skip ALL generation: world.bin (terrain)
// and meta.bin (batches, solids, skyline, tile index) come first; the city's
// static geometry and parcel fabric arrive per 320u tile, nearest first
// (world/world-tiles.ts), so a phone downloads its neighbourhood, not the map.

const gunzip = async (gz: ArrayBuffer): Promise<ArrayBuffer> => {
  const ds = new DecompressionStream("gzip");
  return await new Response(new Blob([gz]).stream().pipeThrough(ds)).arrayBuffer();
};

// The artifacts are served immutable (1yr browser cache) from unversioned
// paths — the rev query is what lets a rebake reach returning players.
const bust = (path: string): string => `${path}?v=${WORLD_REV}`;

// Phone browsers evict the HTTP cache under pressure, and every visit then
// re-downloads its neighbourhood. Cache Storage is a second copy the browser
// treats as site data, so returning players load tiles without the network.
// One cache per world rev: opening the current one drops the rest.
const CACHE_PREFIX = "crazy-waymo-world-";
const worldCache = async (): Promise<Cache | null> => {
  if (!("caches" in globalThis)) {
    return null;
  }
  try {
    const name = `${CACHE_PREFIX}${WORLD_REV}`;
    const cache = await caches.open(name);
    for (const key of await caches.keys()) {
      if (key.startsWith(CACHE_PREFIX) && key !== name) {
        void caches.delete(key);
      }
    }
    return cache;
  } catch {
    // Cache Storage is unavailable in some private modes and sandboxed frames.
    return null;
  }
};
const cachePromise = worldCache();

const isGzip = (buf: ArrayBuffer): boolean => {
  // SPA fallbacks answer 200 with index.html — a real artifact is binary
  // and starts with the gzip magic bytes.
  const head = new Uint8Array(buf, 0, 2);
  return head[0] === 0x1f && head[1] === 0x8b;
};

const readCached = async (cache: Cache | null, url: string): Promise<ArrayBuffer | null> => {
  if (!cache) {
    return null;
  }
  try {
    const hit = await cache.match(url);
    if (!hit) {
      return null;
    }
    const buf = await hit.arrayBuffer();
    return isGzip(buf) ? buf : null;
  } catch {
    return null;
  }
};

// Quota failures only cost the next visit its cache; the bytes are already
// in hand, so nothing here may fail the load.
const storeCached = async (cache: Cache | null, url: string, res: Response): Promise<void> => {
  if (!cache) {
    return;
  }
  try {
    await cache.put(url, res);
  } catch {
    // out of quota or storage denied
  }
};

const fetchGz = async (path: string): Promise<ArrayBuffer | null> => {
  const url = bust(path);
  const cache = await cachePromise;
  const cached = await readCached(cache, url);
  if (cached) {
    return cached;
  }
  const res = await fetch(url);
  if (!res.ok) {
    return null;
  }
  const copy = res.clone();
  const buf = await res.arrayBuffer();
  if (!isGzip(buf)) {
    return null;
  }
  void storeCached(cache, url, copy);
  return buf;
};

const fetchBin = async (path: string): Promise<WorldBinPayload | null> => {
  try {
    const gz = await fetchGz(path);
    if (!gz) {
      return null;
    }
    const buf = await gunzip(gz);
    const data = deserializeWorldBin(buf);
    if (data.rev !== WORLD_REV) {
      console.log(`[world-bin] ${path} rev ${data.rev} != ${WORLD_REV} — ignoring`);
      return null;
    }
    console.log(`[world-bin] ${path} loaded`);
    return data;
  } catch (error) {
    console.log(
      `[world-bin] ${path} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : error}`,
    );
    return null;
  }
};

export const fetchBakedWorld = async (): Promise<CityGenPayload | null> => {
  try {
    const d = await fetchBin("world/world.bin");
    return d?.world ? unpackWorld(d.world) : null;
  } catch (error) {
    console.log(
      `[world-bin] world unpack failed: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
};

/** The untiled remainder of the built city, plus the tile index. */
export const fetchWorldMeta = async (): Promise<CityRestMeta | null> => {
  try {
    const d = await fetchBin("world/meta.bin");
    return d?.meta ? unpackMeta(d.meta) : null;
  } catch (error) {
    console.log(
      `[world-bin] meta unpack failed: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
};

export const worldTilePath = (ref: WorldTileRef): string => `world/tiles/${ref.ix}_${ref.iz}.bin`;

/** One world tile. Null on any failure — the streamer retries on its next pass. */
export const fetchWorldTile = async (ref: WorldTileRef): Promise<PackedWorldTile | null> => {
  try {
    const d = await fetchBin(worldTilePath(ref));
    return d?.tile ?? null;
  } catch (error) {
    console.log(
      `[world-bin] tile ${ref.ix},${ref.iz} failed: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
};

/**
 * The parcel source (public/world/parcels.bin), inflated but not decoded —
 * the caller hands the bytes to the parcel worker. Versioned by its own
 * header, not WORLD_REV: it is an INPUT to generation, and a rebake of the
 * world does not change it. Null on any failure — the city then builds no
 * parcel fabric and the kit walk fills the blocks: a worse city, not a
 * broken one.
 */
export const fetchParcelSource = async (): Promise<ArrayBuffer | null> => {
  try {
    const gz = await fetchGz("world/parcels.bin");
    if (!gz) {
      return null;
    }
    const buf = await gunzip(gz);
    console.log(
      `[world-bin] parcels.bin loaded: ${buf.byteLength} bytes (v${PARCEL_SOURCE_VERSION})`,
    );
    return buf;
  } catch (error) {
    console.log(
      `[world-bin] parcels.bin failed: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
};
