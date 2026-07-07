import type { CityRestPayload } from "./city";
import type { CityGenPayload } from "./gen-worker";
import { deserializeWorldBin, unpackRest, unpackWorld, WORLD_REV } from "./world-bin";

// Loader for the pre-baked world shipped as static assets (public/world/*.bin,
// gzipped by the bake). First visits skip ALL generation: the title needs only
// world.bin (roads + terrain); rest.bin (the built city) streams behind it.

async function fetchBin(
  path: string,
): Promise<{ rev: number; world?: unknown; rest?: unknown } | null> {
  try {
    const res = await fetch(path);
    if (!res.ok || !res.body) return null;
    const ds = new DecompressionStream("gzip");
    const buf = await new Response(res.body.pipeThrough(ds)).arrayBuffer();
    const data = deserializeWorldBin(buf);
    if (data.rev !== WORLD_REV) {
      console.log(`[world-bin] ${path} rev ${data.rev} != ${WORLD_REV} — ignoring`);
      return null;
    }
    console.log(`[world-bin] ${path} loaded`);
    return data;
  } catch {
    return null;
  }
}

export function fetchBakedWorld(): Promise<CityGenPayload | null> {
  return fetchBin("world/world.bin")
    .then((d) => (d?.world ? unpackWorld(d.world) : null))
    .catch(() => null);
}

export function fetchBakedRest(): Promise<CityRestPayload | null> {
  return fetchBin("world/rest.bin")
    .then((d) => (d?.rest ? unpackRest(d.rest) : null))
    .catch(() => null);
}
