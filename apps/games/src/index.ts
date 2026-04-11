import { createDb } from "@repo/db/drizzle-client";
import { deploymentFile, game } from "@repo/db/drizzle-schema";
import { and, eq } from "drizzle-orm";

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
      columns: { id: true, currentDeploymentId: true },
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

    const headers = new Headers();
    headers.set("content-type", fileRow?.contentType ?? "application/octet-stream");
    headers.set(
      "cache-control",
      requestedPath === "index.html"
        ? "public, max-age=60"
        : "public, max-age=31536000, immutable",
    );
    headers.set(
      "content-security-policy",
      "frame-ancestors 'self' https://vibedgames.com https://*.vibedgames.com",
    );
    headers.set("x-content-type-options", "nosniff");

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
