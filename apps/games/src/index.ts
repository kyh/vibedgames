import { createDb } from "@repo/db/drizzle-client";
import { deploymentFile, game } from "@repo/db/drizzle-schema";
import { and, eq, inArray } from "drizzle-orm";

import {
  extractDescription,
  extractTitle,
  hasOwnShareMeta,
  injectShareMeta,
  OG_IMAGE_CANDIDATES,
} from "./share-meta";

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
 * - `frame-ancestors` blocks arbitrary sites from embedding games; vibedgames
 *   itself can still frame them for previews.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const hostHeader = request.headers.get("host") ?? url.host;
    const host = hostHeader.split(":")[0] ?? "";

    const slug = extractSlug(host);
    if (!slug) {
      return notFound("Invalid host");
    }

    const db = createDb(env.DB);

    const g = await db.query.game.findFirst({
      where: eq(game.slug, slug),
      columns: { id: true, name: true, currentDeploymentId: true },
    });

    if (!g?.currentDeploymentId) {
      return notFound("Game not found");
    }

    const requestedPath = normalizePath(url.pathname);
    const r2Key = `games/${g.id}/${g.currentDeploymentId}/${requestedPath}`;

    const [obj, fileRow] = await Promise.all([
      env.GAMES_BUCKET.get(r2Key),
      db.query.deploymentFile.findFirst({
        where: and(
          eq(deploymentFile.deploymentId, g.currentDeploymentId),
          eq(deploymentFile.path, requestedPath),
        ),
        columns: { contentType: true },
      }),
    ]);

    if (!obj) {
      return notFound("File not found");
    }

    const contentType = fileRow?.contentType ?? "application/octet-stream";

    const headers = new Headers();
    headers.set("content-type", contentType);
    // Hashed assets are immutable per deployment; anything addressed by a
    // stable path (html entry points, conventional og images) changes across
    // deploys and must stay on a short TTL.
    const stablePath = requestedPath.endsWith("index.html") || OG_IMAGE_CANDIDATES.includes(requestedPath);
    headers.set(
      "cache-control",
      stablePath ? "public, max-age=60" : "public, max-age=31536000, immutable",
    );
    headers.set(
      "content-security-policy",
      "frame-ancestors 'self' https://vibedgames.com https://*.vibedgames.com http://localhost:* https://localhost:*",
    );
    headers.set("x-content-type-options", "nosniff");

    // Games that don't manage their own Open Graph tags get a default share
    // card, so links pasted into chat/social render a preview instead of a
    // bare URL. HTML is buffered for inspection — game pages are small and
    // index.html already runs on a 60s cache.
    if (contentType.startsWith("text/html")) {
      const html = await obj.text();
      if (!hasOwnShareMeta(html)) {
        const title = g.name ?? extractTitle(html) ?? slug;
        const imageRows = await db.query.deploymentFile.findMany({
          where: and(
            eq(deploymentFile.deploymentId, g.currentDeploymentId),
            inArray(deploymentFile.path, OG_IMAGE_CANDIDATES),
          ),
          columns: { path: true },
        });
        const image = OG_IMAGE_CANDIDATES.map((p) =>
          imageRows.find((row) => row.path === p),
        ).find((row) => row !== undefined);
        const injected = injectShareMeta(html, {
          title,
          description: extractDescription(html) ?? `Play ${title} on vibedgames.`,
          url: `https://${host}${url.pathname}`,
          imageUrl: image
            ? `https://${host}/${image.path}`
            : "https://vibedgames.com/og.jpg",
        });
        return new Response(injected, { headers });
      }
      return new Response(html, { headers });
    }

    return new Response(obj.body, { headers });
  },
};

/**
 * Extract the subdomain slug from `{slug}.vibedgames.com`. Returns null for
 * apex, www, or anything that doesn't match the expected shape.
 */
function extractSlug(host: string): string | null {
  const parts = host.split(".");
  if (parts.length < 3) return null;
  if (parts.at(-2) !== "vibedgames") return null;
  const slug = parts[0];
  if (!slug || slug === "www") return null;
  return slug;
}

function normalizePath(pathname: string): string {
  let p = pathname.replace(/^\/+/, "");
  if (p === "" || p.endsWith("/")) p += "index.html";
  return p;
}

function notFound(message: string): Response {
  return new Response(message, {
    status: 404,
    headers: { "content-type": "text/plain" },
  });
}
