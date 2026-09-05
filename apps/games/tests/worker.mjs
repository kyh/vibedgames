// Headless checks for the games host: serving, share/freshness injection, the
// edge cache and model compression. Runs the real bundled worker inside
// workerd via Miniflare against an in-memory D1 + R2.
//
//   pnpm --filter @repo/games test
//
// Harness limits worth knowing before reading a result:
//   * workerd normalises the inbound `accept-encoding`, so a request made here
//     with `identity` still reaches the worker as gzip-capable. Whether a
//     non-gzip client gets a plain body is negotiated by Cloudflare's edge and
//     is not observable from inside Miniflare.
//   * Miniflare's dispatchFetch behaves like a browser: it decodes exactly ONE
//     `content-encoding` layer and strips the header. A correctly encoded
//     body therefore arrives here as the ORIGINAL bytes, and gzip magic in a
//     body means the worker wrapped it twice — which is exactly what the old
//     assertions were passing on (the runtime re-encoded a body that already
//     carried `content-encoding: gzip`, and the harness peeled one layer).
//     That compression happens at all is asserted through `vary`; the wire
//     bytes are checked against prod with
//     `curl -sH 'Accept-Encoding: gzip' <glb> | gunzip | head -c4` → `glTF`.
//
// miniflare is held at 4.x on purpose. npm's `latest` is a 5.x -alpha that
// replaces the top-level single-worker options below with a per-worker
// `config` object; adopting it is a migration, not a version bump. Don't let a
// blanket dependency update carry this one along.
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass });
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const INDEX_HTML =
  "<!doctype html><html><head><title>Verify</title></head><body><h1>hi</h1></body></html>";

/** A stand-in for a rigged GLB: binary, and redundant enough to compress like
 *  one, without depending on any game's build output being present. */
function fakeGlb(bytes) {
  const buf = Buffer.alloc(bytes);
  buf.write("glTF");
  for (let i = 4; i < bytes; i++) buf[i] = (i * 7) % 61;
  return buf;
}

const mf = new Miniflare({
  modules: true,
  // The bundled worker ships as .js; without this Miniflare parses it as CJS.
  modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }],
  scriptPath: join(HERE, "host-shim.mjs"),
  modulesRoot: ROOT,
  compatibilityDate: "2025-04-01",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: "vibedgames" },
  r2Buckets: { GAMES_BUCKET: "vibedgames-games" },
  cache: true,
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
// A game's own baked world data arrives already gzipped; a second pass on it is
// pure CPU for ~1%, so the worker must leave it alone.
await bucket.put("games/g1/depA/world/rest.bin", Buffer.alloc(4096, 7));

const get = (path, headers = { "accept-encoding": "gzip, br" }) =>
  mf.dispatchFetch(`https://verify.vibedgames.com${path}`, { headers });
const isGzip = (b) => b[0] === 0x1f && b[1] === 0x8b;
const body = async (res) => Buffer.from(await res.arrayBuffer());

// ---- compression -----------------------------------------------------------
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
// Regression: a Response built with `content-encoding: gzip` and no
// `encodeBody: "manual"` is gzipped a second time by the runtime. The harness
// peels one layer, so the bug shows up here as a gzip-magic body of the wrong
// length rather than the model.
check(
  "glb arrives as the model, not a second gzip layer",
  coldBody.equals(glb),
  isGzip(coldBody)
    ? `double-encoded (${coldBody.length} bytes of gzip)`
    : `${coldBody.length} bytes`,
);

// ---- edge cache ------------------------------------------------------------
await new Promise((r) => setTimeout(r, 300));
const warm = await get("/models/hero.glb");
const warmBody = await body(warm);
check("second request is an edge-cache hit", warm.headers.get("x-vg-cache") === "hit");
// Regression: the cached copy is our own gzip stored as opaque octets; the
// rebuilt Response must carry it out with the encoding declared AND marked
// manual, or the hit path double-encodes even when the cold path is right.
check(
  "cache hit arrives as the model, not a second gzip layer",
  warmBody.equals(glb),
  isGzip(warmBody)
    ? `double-encoded (${warmBody.length} bytes of gzip)`
    : `${warmBody.length} bytes`,
);

// ---- payloads that must be left alone --------------------------------------
const bin = await body(await get("/world/rest.bin"));
check("pre-gzipped .bin world payloads are not re-compressed", !isGzip(bin) && bin.length === 4096);

// ---- html ------------------------------------------------------------------
const html = await get("/");
const htmlText = await html.text();
check("html served", html.status === 200 && htmlText.includes("<h1>hi</h1>"));
check("html bypasses the edge cache", html.headers.get("x-vg-cache") === "bypass");
check("html keeps its short TTL", (html.headers.get("cache-control") ?? "").includes("max-age=60"));
check("freshness probe injected", htmlText.includes("__vg/version") && htmlText.includes("depA"));
check("share meta injected", htmlText.includes("og:title"));

// ---- a redeploy must not serve stale bytes ---------------------------------
// Games address assets by stable paths — `models/hero.glb` is not
// fingerprinted, so a new deployment reuses the URL and the cache key has to
// carry the deployment id.
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

// ---- unchanged behaviour ---------------------------------------------------
const missing = await get("/nope.glb");
await missing.text();
check("missing file 404s", missing.status === 404, `status ${missing.status}`);
check(
  "frame-ancestors policy preserved",
  (cold.headers.get("content-security-policy") ?? "").includes("frame-ancestors"),
);
check("assets stay immutable", (cold.headers.get("cache-control") ?? "").includes("immutable"));
check("version probe answers", (await (await get("/__vg/version")).text()) === "depB");

const bad = await mf.dispatchFetch("https://vibedgames.com/", {});
await bad.text();
check("apex host is rejected", bad.status === 404);

await mf.dispose();

const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
