import { verifyDownloadUrl } from "@repo/service/storage/signed-urls";
import { createFileRoute } from "@tanstack/react-router";

import { getServerContext } from "@/auth/server";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { jsonError } from "@/lib/json-error";

const handler = async (request: Request) => {
  const { signing } = getServerContext();

  if (!signing) {
    return jsonError(503, "SERVICE_UNAVAILABLE", "downloads are not configured on this worker");
  }

  const allowed = await verifyDownloadUrl(new URL(request.url).searchParams, signing.secret);

  if ("error" in allowed) {
    return jsonError(400, "BAD_REQUEST", allowed.error);
  }

  const env = getCloudflareEnv();
  const object = await env.GAMES_BUCKET.get(allowed.key);

  if (!object) {
    return jsonError(404, "NOT_FOUND", "not found");
  }

  return new Response(object.body, {
    headers: {
      "cache-control": "no-store",
      "content-length": String(object.size),
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    },
    status: 200,
  });
};

export const Route = createFileRoute("/api/download")({
  server: {
    handlers: {
      GET: async ({ request }) => await handler(request),
    },
  },
});
