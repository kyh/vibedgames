import type { CityRestPayload } from "./city";
import type { CityGenPayload } from "./gen-worker";
import { deserializeWorldBin, unpackRest, unpackWorld, WORLD_REV } from "./world-bin";

// Loader for the pre-baked world shipped as static assets (public/world/*.bin,
// gzipped by the bake). First visits skip ALL generation: the title needs only
// world.bin (roads + terrain); rest.bin (the built city) streams behind it.

async function gunzip(gz: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream("gzip");
  return await new Response(new Blob([gz]).stream().pipeThrough(ds)).arrayBuffer();
}

// The platform caps files at 10MB — big artifacts ship as .0..N parts with a
// .parts count file. Parts download in parallel.
async function fetchMaybeParts(path: string): Promise<ArrayBuffer | null> {
  const single = await fetch(path);
  if (single.ok) return await single.arrayBuffer();
  const partsRes = await fetch(`${path.replace(".bin", ".parts")}`);
  if (!partsRes.ok) return null;
  const n = parseInt((await partsRes.text()).trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > 64) return null;
  const parts = await Promise.all(
    Array.from({ length: n }, (_, i) => fetch(`${path}.${i}`).then((r) => (r.ok ? r.arrayBuffer() : null))),
  );
  if (parts.some((p) => p === null)) return null;
  const total = parts.reduce((a, p) => a + (p?.byteLength ?? 0), 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    if (!p) return null;
    out.set(new Uint8Array(p), off);
    off += p.byteLength;
  }
  return out.buffer;
}

async function fetchBin(
  path: string,
): Promise<{ rev: number; world?: unknown; rest?: unknown } | null> {
  try {
    const gz = await fetchMaybeParts(path);
    if (!gz) return null;
    const buf = await gunzip(gz);
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
