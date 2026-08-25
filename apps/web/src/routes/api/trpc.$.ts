import { createFileRoute } from "@tanstack/react-router";

// Legacy endpoint for published CLI copies (<= 0.4.x) that still speak tRPC
// here. The API now lives at /api/orpc; this stub exists only to tell those
// installs to upgrade, in the one response shape their client can render.
// Remove it once the hit logging below goes quiet.

const UPGRADE_MESSAGE = "Your vibedgames CLI is out of date — run `npm i -g vibedgames@latest`.";

// tRPC's JSON-RPC code for BAD_REQUEST. Inlined so this route needs no
// @trpc/server dependency.
const TRPC_BAD_REQUEST = -32600;

function upgradeRequiredResponse(req: Request): Response {
  // Match tRPC's HTTP error shape so the client (httpBatchLink) surfaces the
  // message instead of throwing "unable to transform response". The CLI's
  // links use the superjson transformer, which deserializes the `error`
  // member expecting superjson's `{ json }` wrapper — omitting it reproduces
  // exactly that transform error (verified against the published 0.4.1).
  const errorObj = {
    error: {
      json: {
        message: UPGRADE_MESSAGE,
        code: TRPC_BAD_REQUEST,
        data: {
          code: "BAD_REQUEST",
          httpStatus: 400,
        },
      },
    },
  };
  const url = new URL(req.url);
  const isBatch = url.searchParams.has("batch");
  let body: typeof errorObj | Array<typeof errorObj> = errorObj;
  if (isBatch) {
    // tRPC batch URLs encode procedures as a comma-separated path
    // segment (e.g. /api/trpc/x.a,y.b). httpBatchLink expects one
    // response slot per procedure, so size the array to match instead
    // of always returning a single-element array.
    const lastSegment = url.pathname.split("/").findLast((segment) => segment.length > 0) ?? "";
    const count = Math.max(1, lastSegment.split(",").filter((s) => s.length > 0).length);
    body = Array.from({ length: count }, () => errorObj);
  }
  return new Response(JSON.stringify(body), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

const handler = (req: Request): Response => {
  // Time this route's removal off real traffic.
  console.log(`>>> legacy tRPC hit: ${new URL(req.url).pathname}`);
  return upgradeRequiredResponse(req);
};

export const Route = createFileRoute("/api/trpc/$")({
  server: {
    handlers: {
      GET: ({ request }) => handler(request),
      POST: ({ request }) => handler(request),
    },
  },
});
