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

const handler = (req: Request) => {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      return new Response(
        `request body exceeds ${MAX_BODY_BYTES} bytes`,
        { status: 413 },
      );
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
