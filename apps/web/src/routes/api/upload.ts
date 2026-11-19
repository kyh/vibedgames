import { MAX_UPLOAD_BODY } from "@repo/contract/deploy/deploy-schema";
import { verifyUploadUrl } from "@repo/service/storage/signed-urls";
import { createFileRoute } from "@tanstack/react-router";

import { getServerContext } from "@/auth/server";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { jsonError } from "@/lib/json-error";

const MAX_UPLOAD_BYTES = MAX_UPLOAD_BODY;
const MAX_FORWARD_BYTES = 50 * 1024 * 1024;

const badRequest = (message: string) => jsonError(400, "BAD_REQUEST", message);

const handler = async (request: Request) => {
  const { signing } = getServerContext();

  if (!signing) {
    return jsonError(503, "SERVICE_UNAVAILABLE", "uploads are not configured on this worker");
  }

  const allowed = await verifyUploadUrl(new URL(request.url).searchParams, signing.secret);

  if ("error" in allowed) {
    return badRequest(allowed.error);
  }

  const length = Number(request.headers.get("content-length") ?? "");

  if (!request.headers.has("content-length") || !Number.isSafeInteger(length) || length < 0) {
    return jsonError(411, "LENGTH_REQUIRED", "content-length required");
  }

  if (length > MAX_UPLOAD_BYTES) {
    return jsonError(413, "PAYLOAD_TOO_LARGE", "payload too large");
  }

  if ("url" in allowed.target) {
    if (length > MAX_FORWARD_BYTES) {
      return jsonError(413, "PAYLOAD_TOO_LARGE", "payload too large");
    }

    const forwarded = await fetch(allowed.target.url, {
      body: await request.arrayBuffer(),
      headers: { "content-type": allowed.contentType },
      method: "PUT",
    });

    if (!forwarded.ok) {
      return jsonError(502, "BAD_GATEWAY", `storage refused the upload (${forwarded.status})`);
    }

    return new Response(null, { status: 200 });
  }

  const { readable, writable } = new FixedLengthStream(length);
  const env = getCloudflareEnv();
  await Promise.all([
    (request.body ?? new Blob([]).stream()).pipeTo(writable),
    env.GAMES_BUCKET.put(allowed.target.key, readable, {
      httpMetadata: { contentType: allowed.contentType },
    }),
  ]);

  return new Response(null, { status: 200 });
};

export const Route = createFileRoute("/api/upload")({
  server: {
    handlers: {
      PUT: ({ request }) => handler(request),
    },
  },
});
