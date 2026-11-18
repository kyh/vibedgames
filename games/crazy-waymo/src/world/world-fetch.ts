import type { CityGenPayload } from "./gen-worker";
import { deserializeWorldBin, unpackMeta, unpackWorld, WORLD_REV } from "./world-bin";
import type { PackedWorldTile, WorldTileRef } from "./world-bin";
import { PARCEL_SOURCE_VERSION } from "./parcel-source";

const gunzip = async (gz: ArrayBuffer) => {
  const ds = new DecompressionStream("gzip");

  return await new Response(new Blob([gz]).stream().pipeThrough(ds)).arrayBuffer();
};

const bust = (path: string) => `${path}?v=${WORLD_REV}`;

const CACHE_PREFIX = "crazy-waymo-world-";

const worldCache = async () => {
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
    return null;
  }
};

const cachePromise = worldCache();

const isGzip = (buf: ArrayBuffer) => {
  const head = new Uint8Array(buf, 0, 2);

  return head[0] === 0x1f && head[1] === 0x8b;
};

const readCached = async (cache: Cache | null, url: string) => {
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

const storeCached = async (cache: Cache | null, url: string, res: Response) => {
  if (!cache) {
    return;
  }

  try {
    await cache.put(url, res);
  } catch {}
};

const fetchGz = async (path: string) => {
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

const fetchBin = async (path: string) => {
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

export const fetchBakedWorld: () => Promise<CityGenPayload | null> = async () => {
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
export const fetchWorldMeta = async () => {
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

export const worldTilePath = (ref: WorldTileRef) => `world/tiles/${ref.ix}_${ref.iz}.bin`;

/** One world tile. Null on any failure — the streamer retries on its next pass. */
export const fetchWorldTile = async (ref: WorldTileRef) => {
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
export const fetchParcelSource = async () => {
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
