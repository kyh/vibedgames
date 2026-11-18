import { Miniflare } from "miniflare";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");

const checks = [];

const check = (name, pass, detail = "") => {
  checks.push({ name, pass });
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const INDEX_HTML =
  "<!doctype html><html><head><title>Verify</title></head><body><h1>hi</h1></body></html>";

const fakeGlb = (bytes) => {
  const buf = Buffer.alloc(bytes);
  buf.write("glTF");

  for (let i = 4; i < bytes; i += 1) {
    buf[i] = (i * 7) % 61;
  }

  return buf;
};

const mf = new Miniflare({
  cache: true,
  compatibilityDate: "2025-04-01",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: "vibedgames" },
  modules: true,
  modulesRoot: ROOT,
  modulesRules: [{ include: ["**/*.js", "**/*.mjs"], type: "ESModule" }],
  r2Buckets: { GAMES_BUCKET: "vibedgames-games" },
  scriptPath: path.join(HERE, "host-shim.mjs"),
});

const db = await mf.getD1Database("DB");

await db.exec(
  "CREATE TABLE game (id TEXT PRIMARY KEY, user_id TEXT, slug TEXT, name TEXT, current_deployment_id TEXT, created_at INTEGER, updated_at INTEGER)",
);

await db.exec(
  "CREATE TABLE deployment_file (id TEXT PRIMARY KEY, deployment_id TEXT, path TEXT, size INTEGER, sha256 TEXT, content_type TEXT)",
);

await db.exec("INSERT INTO game VALUES ('g1','u1','verify','Verify','depA',0,0)");

const bucket = await mf.getR2Bucket("GAMES_BUCKET");
const glb = fakeGlb(512 * 1024);

await bucket.put("games/g1/depA/models/hero.glb", glb);

await bucket.put("games/g1/depA/index.html", INDEX_HTML);

await bucket.put("games/g1/depA/world/rest.bin", Buffer.alloc(4096, 7));

const ACCEPT_GZIP = { "accept-encoding": "gzip, br" };

const get = (pathname, headers = ACCEPT_GZIP) =>
  mf.dispatchFetch(`https://verify.vibedgames.com${pathname}`, { headers });

const isGzip = (b) => b[0] === 0x1f && b[1] === 0x8b;
const body = async (res) => Buffer.from(await res.arrayBuffer());

const cold = await get("/models/hero.glb");
const coldBody = await body(cold);

check("glb served", cold.status === 200, `status ${cold.status}`);

check(
  "glb typed model/gltf-binary",
  cold.headers.get("content-type") === "model/gltf-binary",
  cold.headers.get("content-type") ?? "none",
);

check("vary: accept-encoding set", (cold.headers.get("vary") ?? "").includes("accept-encoding"));

check("cold request reports a cache miss", cold.headers.get("x-vg-cache") === "miss");

check(
  "glb arrives as the model, not a second gzip layer",
  coldBody.equals(glb),
  isGzip(coldBody)
    ? `double-encoded (${coldBody.length} bytes of gzip)`
    : `${coldBody.length} bytes`,
);

await sleep(300);

const warm = await get("/models/hero.glb");
const warmBody = await body(warm);

check("second request is an edge-cache hit", warm.headers.get("x-vg-cache") === "hit");

check(
  "cache hit arrives as the model, not a second gzip layer",
  warmBody.equals(glb),
  isGzip(warmBody)
    ? `double-encoded (${warmBody.length} bytes of gzip)`
    : `${warmBody.length} bytes`,
);

const bin = await body(await get("/world/rest.bin"));

check("pre-gzipped .bin world payloads are not re-compressed", !isGzip(bin) && bin.length === 4096);

const html = await get("/");
const htmlText = await html.text();

check("html served", html.status === 200 && htmlText.includes("<h1>hi</h1>"));

check("html bypasses the edge cache", html.headers.get("x-vg-cache") === "bypass");

check("html keeps its short TTL", (html.headers.get("cache-control") ?? "").includes("max-age=60"));

check("freshness probe injected", htmlText.includes("__vg/version") && htmlText.includes("depA"));

check("share meta injected", htmlText.includes("og:title"));

const next = Buffer.concat([glb, Buffer.from("REDEPLOYED")]);

await bucket.put("games/g1/depB/models/hero.glb", next);

await bucket.put("games/g1/depB/index.html", INDEX_HTML);

await db.exec("UPDATE game SET current_deployment_id = 'depB' WHERE id = 'g1'");

const after = await get("/models/hero.glb");
const afterBody = await body(after);

check("redeploy is a cache miss", after.headers.get("x-vg-cache") === "miss");

check(
  "redeploy serves the new bytes",
  (isGzip(afterBody) ? gunzipSync(afterBody) : afterBody).equals(next),
);

const missing = await get("/nope.glb");

await missing.text();

check("missing file 404s", missing.status === 404, `status ${missing.status}`);

check(
  "frame-ancestors policy preserved",
  (cold.headers.get("content-security-policy") ?? "").includes("frame-ancestors"),
);

check("assets stay immutable", (cold.headers.get("cache-control") ?? "").includes("immutable"));

const version = await get("/__vg/version");

check("version probe answers", (await version.text()) === "depB");

const bad = await mf.dispatchFetch("https://vibedgames.com/", {});

await bad.text();

check("apex host is rejected", bad.status === 404);

await mf.dispose();

const failed = checks.filter((c) => !c.pass).length;

console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

process.exit(failed ? 1 : 0);
