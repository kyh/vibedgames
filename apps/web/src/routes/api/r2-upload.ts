import { verifyProxyUploadUrl } from "@repo/api/deploy/r2-presign";
import { createFileRoute } from "@tanstack/react-router";

import { getServerContext } from "@/auth/server";
import { getCloudflareEnv } from "@/lib/cloudflare";

// Bundle files cap at 10 MB each (enforced in the deploy router), but the
// source archive rides the same proxy and can be larger — allow up to the
// server-side source cap.
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

/**
 * Worker-proxied R2 upload endpoint, used only when `presignPut` returns a
 * proxy URL (currently only in local dev, so uploads land in the
 * Miniflare-simulated bucket instead of prod R2).
 *
 * Authentication is via HMAC-signed query string — the deploy router signs
 * the URL with `BETTER_AUTH_SECRET`, the CLI PUTs the body, and we verify the
 * signature here before writing to the binding. No session cookie required
 * because the CLI's `uploadAll` fetches without auth headers.
 */
async function handler(request: Request): Promise<Response> {
  if (request.method !== "PUT") return badRequest("method not allowed");

  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const contentType = url.searchParams.get("ct");
  const expStr = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (!key || !contentType || !expStr || !sig) {
    return badRequest("missing query params (key, ct, exp, sig)");
  }
  const exp = Number(expStr);

  const { r2 } = getServerContext();
  if (!r2?.proxyUploadSecret) {
    return new Response("proxy upload disabled", { status: 503 });
  }

  const verifyError = await verifyProxyUploadUrl({
    key,
    contentType,
    exp,
    sig,
    secret: r2.proxyUploadSecret,
  });
  if (verifyError) return badRequest(verifyError);

  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (!Number.isFinite(declaredLength) || declaredLength < 0) {
    return new Response("content-length required", { status: 411 });
  }
  if (declaredLength > MAX_UPLOAD_BYTES) {
    return new Response("payload too large", { status: 413 });
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    return new Response("payload too large", { status: 413 });
  }

  const env = getCloudflareEnv();
  await env.GAMES_BUCKET.put(key, buffer, {
    httpMetadata: { contentType },
  });

  return new Response(null, { status: 200 });
}

export const Route = createFileRoute("/api/r2-upload")({
  server: {
    handlers: {
      PUT: ({ request }) => handler(request),
    },
  },
});
