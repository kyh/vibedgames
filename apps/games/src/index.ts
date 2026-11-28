import { createDb } from "@repo/db/drizzle-client";
import type { Db } from "@repo/db/drizzle-client";

import { assetCacheKey } from "./cache-key";

import { contentTypeForPath } from "./content-type";
import { injectFreshness, VERSION_PATH, versionResponse } from "./freshness";
import {
  extractDescription,
  extractTitle,
  hasOwnShareMeta,
  injectShareMeta,
  OG_IMAGE_CANDIDATES,
} from "./share-meta";

const COMPRESSIBLE_TYPES = new Set(["model/gltf-binary", "model/gltf+json", "application/wasm"]);

const acceptsGzip = (request: Request) =>
  (request.headers.get("accept-encoding") ?? "").toLowerCase().includes("gzip");

const ENCODING_MARKER = "x-vg-encoded";

const toCache = (response: Response, headers: Headers, compressed: boolean) => {
  const stored = new Headers(headers);
  stored.set("x-vg-cache", "hit");

  if (compressed) {
    stored.delete("content-encoding");
    stored.set(ENCODING_MARKER, "gzip");
  }

  return new Response(response.body, { headers: stored });
};

const fromCache = (hit: Response) => {
  const encoding = hit.headers.get(ENCODING_MARKER);

  if (encoding === null || encoding === "") {
    return hit;
  }

  const headers = new Headers(hit.headers);
  headers.delete(ENCODING_MARKER);
  headers.set("content-encoding", encoding);

  return new Response(hit.body, { encodeBody: "manual", headers });
};

const extractSlug = (host: string) => {
  const parts = host.split(".");

  if (parts.length < 3) {
    return null;
  }

  if (parts.at(-2) !== "vibedgames") {
    return null;
  }

  const [slug] = parts;

  if (slug === undefined || slug === "" || slug === "www") {
    return null;
  }

  return slug;
};

const normalizePath = (pathname: string) => {
  let p = pathname.replace(/^\/+/u, "");

  if (p === "" || p.endsWith("/")) {
    p += "index.html";
  }

  return p;
};

const notFound = (message: string) =>
  new Response(message, {
    headers: { "content-type": "text/plain" },
    status: 404,
  });

interface HtmlPage {
  db: ReturnType<typeof createDb>;
  deploymentId: string;
  headers: Headers;
  host: string;
  html: string;
  name: string | null;
  pathname: string;
  slug: string;
}

const serveHtml = async (page: HtmlPage) => {
  const { db, deploymentId, headers, host, name, pathname, slug } = page;
  const html = injectFreshness(page.html, deploymentId);

  if (hasOwnShareMeta(html)) {
    return new Response(html, { headers });
  }

  const title = name ?? extractTitle(html) ?? slug;

  const imageRows = await db.query.deploymentFile.findMany({
    columns: { path: true },
    where: { deploymentId, path: { in: OG_IMAGE_CANDIDATES } },
  });

  const image = OG_IMAGE_CANDIDATES.map((p) => imageRows.find((row) => row.path === p)).find(
    (row) => row !== undefined,
  );

  const injected = injectShareMeta(html, {
    description: extractDescription(html) ?? `Play ${title} on vibedgames.`,
    imageUrl: image ? `https://${host}/${image.path}` : "https://www.vibedgames.com/og.jpg",
    title,
    url: `https://${host}${pathname}`,
  });

  return new Response(injected, { headers });
};

const liveGame = async (db: Db, slug: string) => {
  const g = await db.query.game.findFirst({
    columns: { currentDeploymentId: true, id: true, name: true },
    where: { slug },
  });

  const deploymentId = g?.currentDeploymentId;

  return g === undefined ||
    deploymentId === undefined ||
    deploymentId === null ||
    deploymentId === ""
    ? null
    : { deploymentId, id: g.id, name: g.name };
};

const assetHeaders = (contentType: string, requestedPath: string, cacheStatus: string) => {
  const headers = new Headers();
  headers.set("content-type", contentType);

  const stablePath =
    requestedPath.endsWith("index.html") || OG_IMAGE_CANDIDATES.includes(requestedPath);

  headers.set(
    "cache-control",
    stablePath ? "public, max-age=60" : "public, max-age=31536000, immutable",
  );
  headers.set(
    "content-security-policy",
    "frame-ancestors 'self' https://vibedgames.com https://*.vibedgames.com http://localhost:* https://localhost:*",
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-vg-cache", cacheStatus);

  return headers;
};

/**
 * Static host for user-uploaded games.
 *
 *   {slug}.vibedgames.com/*  → games/{gameId}/{currentDeployId}/{path}
 *
 * - Looks up the game by slug.
 * - Resolves path to its R2 key.
 * - Streams the object back with the stored content-type.
 *
 * Notes:
 * - Games are immutable under a deployment id, so hashed assets get
 *   long-lived cache headers. `index.html` gets a short TTL so updates
 *   propagate within a minute.
 * - Asset responses are held in the colo's edge cache, keyed by deployment, so
 *   a warm PoP answers without touching D1 or R2 at all.
 * - `frame-ancestors` blocks arbitrary sites from embedding games; vibedgames
 *   itself can still frame them for previews.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const hostHeader = request.headers.get("host") ?? url.host;
    const host = hostHeader.split(":")[0] ?? "";

    const slug = extractSlug(host);

    if (slug === null || slug === "") {
      return notFound("Invalid host");
    }

    const db = createDb(env.DB);

    const g = await liveGame(db, slug);

    if (g === null) {
      return notFound("Game not found");
    }

    if (url.pathname === VERSION_PATH) {
      return versionResponse(g.deploymentId);
    }

    const requestedPath = normalizePath(url.pathname);
    const r2Key = `games/${g.id}/${g.deploymentId}/${requestedPath}`;

    const contentType = contentTypeForPath(requestedPath);

    const isHtml = contentType.startsWith("text/html");
    const compress = COMPRESSIBLE_TYPES.has(contentType) && acceptsGzip(request);
    const cacheable = !isHtml && request.method === "GET";

    const cacheKey = assetCacheKey(url, g.deploymentId, requestedPath, compress);

    if (cacheable) {
      const hit = await caches.default.match(cacheKey);

      if (hit) {
        return fromCache(hit);
      }
    }

    const cacheStatus = cacheable ? "miss" : "bypass";

    const obj = await env.GAMES_BUCKET.get(r2Key);

    if (!obj) {
      return notFound("File not found");
    }

    const headers = assetHeaders(contentType, requestedPath, cacheStatus);

    if (isHtml) {
      return await serveHtml({
        db,
        deploymentId: g.deploymentId,
        headers,
        host,
        html: await obj.text(),
        name: g.name,
        pathname: url.pathname,
        slug,
      });
    }

    if (compress) {
      headers.set("content-encoding", "gzip");
      headers.set("vary", "accept-encoding");
    }

    const body = compress ? obj.body.pipeThrough(new CompressionStream("gzip")) : obj.body;

    const response = new Response(body, {
      encodeBody: compress ? "manual" : "automatic",
      headers,
    });

    if (cacheable) {
      ctx.waitUntil(caches.default.put(cacheKey, toCache(response.clone(), headers, compress)));
    }

    return response;
  },
};
