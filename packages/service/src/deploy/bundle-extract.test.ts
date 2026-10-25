import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { BundleFile } from "./bundle-extract";
import { forEachBundleFile } from "./bundle-extract";
import { sourceArchive } from "./source-archive";

const encoder = new TextEncoder();
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** One raw tar entry: a header of `type` for `name`, then `data` padded to a block. */
const entry = (name: string, type: string, data: Uint8Array = new Uint8Array(0)) => {
  const header = new Uint8Array(512);
  header.set(encoder.encode(name), 0);
  header.set(encoder.encode(`${data.byteLength.toString(8).padStart(11, "0")}\0`), 124);
  header.set(encoder.encode(type), 156);
  header.set(encoder.encode("ustar\0"), 257);
  const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
  padded.set(data);
  return [header, padded];
};

const gzip = async (parts: Uint8Array[]) => {
  const tar = new Blob([...parts, new Uint8Array(1024)]);
  const zipped = tar.stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(zipped).arrayBuffer());
};

const streamOf = (bytes: Uint8Array<ArrayBuffer>) => new Blob([bytes]).stream();

const read = async (bytes: Uint8Array<ArrayBuffer>, maxFileBytes = 1024 * 1024) => {
  const files: BundleFile[] = [];
  await forEachBundleFile(streamOf(bytes), { maxFileBytes }, (file) => {
    files.push(file);
    return Promise.resolve();
  });
  return files.map((file) => ({ content: text(file.bytes), path: file.path }));
};

describe("forEachBundleFile", () => {
  test("reads back what the source archive writes, long paths included", async () => {
    const deep = `${"d".repeat(120)}/${"f".repeat(90)}.js`;
    const archive = await sourceArchive([
      { path: "index.html", read: () => Promise.resolve(new Uint8Array(encoder.encode("<p>"))) },
      { path: deep, read: () => Promise.resolve(new Uint8Array(encoder.encode("x"))) },
    ]);
    assert.deepStrictEqual(await read(archive), [
      { content: "<p>", path: "index.html" },
      { content: "x", path: deep },
    ]);
  });

  test("strips ./, skips directories and resource forks, and honours pax and GNU names", async () => {
    const paxRecord = "30 path=assets/a-pax-name.png\n";
    const bundle = await gzip([
      ...entry("./", "5"),
      ...entry("./index.html", "0", encoder.encode("hi")),
      ...entry("./._index.html", "0", encoder.encode("fork")),
      ...entry("PaxHeader/x", "x", encoder.encode(paxRecord)),
      ...entry("assets/short.png", "0", encoder.encode("png")),
      ...entry("././@LongLink", "L", encoder.encode("assets/a-gnu-long-name.js\0")),
      ...entry("assets/trunc", "0", encoder.encode("js")),
    ]);
    assert.deepStrictEqual(await read(bundle), [
      { content: "hi", path: "index.html" },
      { content: "png", path: "assets/a-pax-name.png" },
      { content: "js", path: "assets/a-gnu-long-name.js" },
    ]);
  });

  test("refuses a file over the size cap", async () => {
    const bundle = await gzip(entry("big.bin", "0", new Uint8Array(2048)));
    await assert.rejects(read(bundle, 1024), { code: "BAD_REQUEST" });
  });

  test("refuses something that is not gzip", async () => {
    await assert.rejects(read(new Uint8Array(encoder.encode("not a tarball at all"))), {
      code: "BAD_REQUEST",
    });
  });

  test("refuses a truncated archive", async () => {
    const [header] = entry("index.html", "0", new Uint8Array(4096));
    const bundle = await gzip(header ? [header] : []);
    await assert.rejects(read(bundle), { code: "BAD_REQUEST" });
  });
});
