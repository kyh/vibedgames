import { createORPCContext } from "@repo/api";
import { createFileRoute } from "@tanstack/react-router";

import { getServerContext } from "@/auth/server";
import { handleRpcRequest } from "@/lib/orpc-handler";

const handler = async (req: Request): Promise<Response> => {
  const { db, auth, productionUrl, r2, media } = getServerContext();
  const context = await createORPCContext({
    headers: req.headers,
    db,
    auth,
    productionURL: productionUrl,
    r2,
    media,
  });
  return handleRpcRequest(req, context);
};

export const Route = createFileRoute("/api/orpc/$")({
  server: {
    handlers: {
      GET: ({ request }) => handler(request),
      POST: ({ request }) => handler(request),
    },
  },
});
