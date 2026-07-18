import type { CityRestPayload } from "./city";
import type { CityGenPayload } from "./gen-worker";
import { WORLD_REV } from "./world-bin";
import { packRest, packWorld, serializeWorldBin } from "./world-bin-pack";

// ?bake=1: download the two world artifacts (gzipped) for public/world/.
// Run on a COLD dev build so the capture reflects the current pipeline.
// Lazy-loaded (dynamic import) behind the param — tools/bake-world.mjs drives
// this headlessly and waits on the [bake] console lines + the world.bin /
// rest.bin downloads, so keep both exactly as they are.
export async function downloadWorldArtifacts(
  bakePayload: CityGenPayload | null,
  restCapture: CityRestPayload | null,
): Promise<void> {
  const gzip = async (bytes: Uint8Array): Promise<Blob> => {
    const stream = new Blob([new Uint8Array(bytes)])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    return await new Response(stream).blob();
  };
  const save = (blob: Blob, name: string): void => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
  };
  if (bakePayload) {
    console.log("[bake] packing world…");
    save(
      await gzip(serializeWorldBin({ rev: WORLD_REV, world: packWorld(bakePayload) })),
      "world.bin",
    );
  }
  if (restCapture) {
    console.log("[bake] packing rest…");
    const packed = packRest(restCapture);
    console.log("[bake] serializing rest…");
    const bin = serializeWorldBin({ rev: WORLD_REV, rest: packed });
    console.log(`[bake] gzipping rest (${bin.byteLength} bytes)…`);
    save(await gzip(bin), "rest.bin");
  }
  console.log("[bake] artifacts downloaded — move into public/world/ and commit");
}
