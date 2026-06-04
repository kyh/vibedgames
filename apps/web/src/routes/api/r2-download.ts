import { verifyProxyDownloadUrl } from "@repo/api/deploy/r2-presign";
import { createFileRoute } from "@tanstack/react-router";

import { getServerContext } from "@/auth/server";
import { getCloudflareEnv } from "@/lib/cloudflare";

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

/**
 * Worker-proxied R2 download endpoint, the GET counterpart to
 * `/api/r2-upload`. Used only when `presignGet` returns a proxy URL (local
 * dev) so reads come from the Miniflare-simulated bucket binding instead of
 * direct S3 against prod R2 — which the dev worker's source uploads never
 * reach. Auth is the HMAC-signed query string, verified before streaming.
 */
async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return badRequest("method not allowed");

  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const expStr = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (!key || !expStr || !sig) {
    return badRequest("missing query params (key, exp, sig)");
  }

  const { r2 } = getServerContext();
  if (!r2?.proxyUploadSecret) {
    return new Response("proxy download disabled", { status: 503 });
  }

  const verifyError = await verifyProxyDownloadUrl({
    key,
    exp: Number(expStr),
    sig,
    secret: r2.proxyUploadSecret,
  });
  if (verifyError) return badRequest(verifyError);

  const env = getCloudflareEnv();
  const object = await env.GAMES_BUCKET.get(key);
  if (!object) return new Response("not found", { status: 404 });

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "no-store",
    },
  });
}

export const Route = createFileRoute("/api/r2-download")({
  server: {
    handlers: {
      GET: ({ request }) => handler(request),
    },
  },
});
