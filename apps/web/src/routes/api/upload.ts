import { verifyUploadUrl } from "@repo/service/storage/signed-urls";
import { createFileRoute } from "@tanstack/react-router";

import { getServerContext } from "@/auth/server";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { jsonError } from "@/lib/json-error";

// Bundle files cap at 10 MB each (enforced in the deploy router); the source
// archive rides the same URL up to the 100 MB source cap.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// A forwarded model input is held in memory: a signed storage URL wants a
// length, which a streamed outbound body does not reliably carry.
const MAX_FORWARD_BYTES = 50 * 1024 * 1024;

const badRequest = (message: string): Response => jsonError(400, "BAD_REQUEST", message);

/**
 * Takes one PUT a signed URL allows (storage/signed-urls.ts) and streams it to
 * its target: an R2 key through the bucket binding, or the one external URL
 * the server minted it for (an upload slot in generate's storage). Auth is
 * the signature alone, so the CLI and an agent's shell PUT with no headers
 * but the content type, and only ever to this host.
 */
const handler = async (request: Request): Promise<Response> => {
  const { signing } = getServerContext();
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

  // A known length lets R2 take the body as a stream.
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
