import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { repeatWhile } from "@repo/contract/run-in-order";
import { Miniflare } from "miniflare";

import { assetCacheKey } from "../src/cache-key";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const ORIGIN = "https://verify.vibedgames.com";

const HOST_SHIM = `
import worker from "../.cloudflare/output/v0/workers/default/bundle/index.js";

export default {
  fetch(request, env, ctx) {
    const headers = new Headers(request.headers);
    headers.delete("host");

    return worker.fetch(new Request(request.url, { headers, method: request.method }), env, ctx);
  },
};
`;

const INDEX_HTML =
  "<!doctype html><html><head><title>Verify</title></head><body><h1>hi</h1></body></html>";

const fakeGlb = (bytes: number) => {
  const buf = Buffer.alloc(bytes);
  buf.write("glTF");

  for (let i = 4; i < bytes; i += 1) {
    buf[i] = (i * 7) % 61;
  }

  return buf;
};

const ACCEPT_GZIP = { "accept-encoding": "gzip, br" };
const glb = fakeGlb(512 * 1024);
const redeployed = Buffer.concat([glb, Buffer.from("REDEPLOYED")]);

const mf = new Miniflare({
  cache: true,
  compatibilityDate: "2025-04-01",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: "vibedgames" },
  modules: true,
  modulesRoot: ROOT,
  modulesRules: [{ include: ["**/*.js", "**/*.mjs"], type: "ESModule" }],
  r2Buckets: { GAMES_BUCKET: "vibedgames-games" },
  script: HOST_SHIM,
  scriptPath: path.join(HERE, "host-shim.mjs"),
});

const get = async (pathname: string, headers: Record<string, string> = ACCEPT_GZIP) =>
  await mf.dispatchFetch(`${ORIGIN}${pathname}`, { headers });

const isGzip = (bytes: Buffer) => bytes[0] === 0x1f && bytes[1] === 0x8b;

const bodyOf = async (response: Awaited<ReturnType<typeof get>>) =>
  Buffer.from(await response.arrayBuffer());

const cached = async (deploymentId: string, requestedPath: string) => {
  const caches = await mf.getCaches();
  const url = new URL(`${ORIGIN}/${requestedPath}`);

  const [gzipped, plain] = await Promise.all([
    caches.default.match(assetCacheKey(url, deploymentId, requestedPath, true).url),
    caches.default.match(assetCacheKey(url, deploymentId, requestedPath, false).url),
  ]);

  return gzipped !== undefined || plain !== undefined;
};

const untilCached = async (deploymentId: string, requestedPath: string) => {
  const deadline = Date.now() + 10_000;

  await repeatWhile(async () => {
    if (await cached(deploymentId, requestedPath)) {
      return false;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${requestedPath} in the edge cache`);
    }

    await delay(25);

    return true;
  });
};

before(async () => {
  const db = await mf.getD1Database("DB");

  await db.exec(
    "CREATE TABLE game (id TEXT PRIMARY KEY, user_id TEXT, slug TEXT, name TEXT, current_deployment_id TEXT, created_at INTEGER, updated_at INTEGER)",
  );
  await db.exec(
    "CREATE TABLE deployment_file (id TEXT PRIMARY KEY, deployment_id TEXT, path TEXT, size INTEGER, sha256 TEXT, content_type TEXT)",
  );
  await db.exec("INSERT INTO game VALUES ('g1','u1','verify','Verify','depA',0,0)");

  const bucket = await mf.getR2Bucket("GAMES_BUCKET");

  await bucket.put("games/g1/depA/models/hero.glb", glb);
  await bucket.put("games/g1/depA/index.html", INDEX_HTML);
  await bucket.put("games/g1/depA/world/rest.bin", Buffer.alloc(4096, 7));
});

after(async () => {
  await mf.dispose();
});

describe("serving a deployed game", () => {
  test("a cold asset is served typed, as itself, and cached", async () => {
    const cold = await get("/models/hero.glb");
    const body = await bodyOf(cold);

    assert.equal(cold.status, 200);
    assert.equal(cold.headers.get("content-type"), "model/gltf-binary");
    assert.ok((cold.headers.get("vary") ?? "").includes("accept-encoding"));
    assert.equal(cold.headers.get("x-vg-cache"), "miss");
    assert.ok(body.equals(glb), `${isGzip(body) ? "double-encoded" : "different"} body`);
    assert.ok((cold.headers.get("content-security-policy") ?? "").includes("frame-ancestors"));
    assert.ok((cold.headers.get("cache-control") ?? "").includes("immutable"));
  });

  test("a warm asset is an edge-cache hit, still as itself", async () => {
    await untilCached("depA", "models/hero.glb");

    const warm = await get("/models/hero.glb");
    const body = await bodyOf(warm);

    assert.equal(warm.headers.get("x-vg-cache"), "hit");
    assert.ok(body.equals(glb), `${isGzip(body) ? "double-encoded" : "different"} body`);
  });

  test("a pre-gzipped .bin world payload is not compressed again", async () => {
    const bin = await bodyOf(await get("/world/rest.bin"));

    assert.ok(!isGzip(bin));
    assert.equal(bin.length, 4096);
  });

  test("html bypasses the cache, keeps its short TTL and gets the probe and share meta", async () => {
    const html = await get("/");
    const text = await html.text();

    assert.equal(html.status, 200);
    assert.ok(text.includes("<h1>hi</h1>"));
    assert.equal(html.headers.get("x-vg-cache"), "bypass");
    assert.ok((html.headers.get("cache-control") ?? "").includes("max-age=60"));
    assert.ok(text.includes("__vg/version") && text.includes("depA"));
    assert.ok(text.includes("og:title"));
  });

  test("a redeploy is a cache miss serving the new bytes", async () => {
    const bucket = await mf.getR2Bucket("GAMES_BUCKET");
    const db = await mf.getD1Database("DB");

    await bucket.put("games/g1/depB/models/hero.glb", redeployed);
    await bucket.put("games/g1/depB/index.html", INDEX_HTML);
    await db.exec("UPDATE game SET current_deployment_id = 'depB' WHERE id = 'g1'");

    const response = await get("/models/hero.glb");
    const body = await bodyOf(response);

    assert.equal(response.headers.get("x-vg-cache"), "miss");
    assert.ok((isGzip(body) ? gunzipSync(body) : body).equals(redeployed));
  });

  test("a missing file is a 404", async () => {
    const missing = await get("/nope.glb");

    await missing.text();
    assert.equal(missing.status, 404);
  });

  test("the version probe answers the live deployment", async () => {
    const version = await get("/__vg/version");

    assert.equal(await version.text(), "depB");
  });

  test("the apex host is refused", async () => {
    const bad = await mf.dispatchFetch("https://vibedgames.com/", {});

    await bad.text();
    assert.equal(bad.status, 404);
  });
});
