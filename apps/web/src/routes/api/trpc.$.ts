import { appRouter, createTRPCContext } from "@repo/api";
import { createFileRoute } from "@tanstack/react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { getServerContext } from "@/auth/server";

// Hard ceiling on tRPC request bodies, enforced before tRPC/Zod parse
// the payload. The Worker memory ceiling is 128 MB and JSON.parse holds
// the raw bytes, the decoded string, and the parsed object in memory at
// once, so we have to reject pathologically large bodies up front
// rather than relying on the per-field caps inside the procedure.
const MAX_BODY_BYTES = 64 * 1024 * 1024;

// JSON-RPC code tRPC uses for PAYLOAD_TOO_LARGE (HTTP 413). Inlined to
// avoid importing from the `unstable-core-do-not-import` entry point.
const TRPC_PAYLOAD_TOO_LARGE = -32013;

function bodyTooLargeResponse(req: Request): Response {
  // Match tRPC's HTTP error shape so the client (httpBatchLink) can
  // parse the JSON and surface the message instead of throwing
  // "unable to transform response" on a plain-text body.
  const message = `request body exceeds ${MAX_BODY_BYTES} bytes`;
  const errorObj = {
    error: {
      message,
      code: TRPC_PAYLOAD_TOO_LARGE,
      data: {
        code: "PAYLOAD_TOO_LARGE",
        httpStatus: 413,
      },
    },
  };
  const url = new URL(req.url);
  const isBatch = url.searchParams.has("batch");
  let body: unknown = errorObj;
  if (isBatch) {
    // tRPC batch URLs encode procedures as a comma-separated path
    // segment (e.g. /api/trpc/x.a,y.b). httpBatchLink expects one
    // response slot per procedure, so size the array to match instead
    // of always returning a single-element array.
    const lastSegment = url.pathname.split("/").filter(Boolean).pop() ?? "";
    const count = Math.max(
      1,
      lastSegment.split(",").filter((s) => s.length > 0).length,
    );
    body = Array.from({ length: count }, () => errorObj);
  }
  return new Response(JSON.stringify(body), {
    status: 413,
    headers: { "content-type": "application/json" },
  });
}

const handler = (req: Request) => {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      return bodyTooLargeResponse(req);
    }
  }
  const { db, auth, productionUrl, r2, imageProviders } = getServerContext();
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    router: appRouter,
    req,
    createContext: () =>
      createTRPCContext({
        headers: req.headers,
        db,
        auth,
        productionURL: productionUrl,
        r2,
        imageProviders,
      }),
    onError({ error, path }) {
      console.error(`>>> tRPC Error on '${path}'`, error);
    },
  });
};

export const Route = createFileRoute("/api/trpc/$")({
  server: {
    handlers: {
      GET: ({ request }) => handler(request),
      POST: ({ request }) => handler(request),
    },
  },
});
