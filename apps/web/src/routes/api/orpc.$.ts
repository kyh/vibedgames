import { createFileRoute } from "@tanstack/react-router";

import { createRpcContext } from "@/auth/server";
import { handleRpcRequest } from "@/lib/orpc-handler";

const handler = async (req: Request) =>
  await handleRpcRequest(req, await createRpcContext(req.headers));

export const Route = createFileRoute("/api/orpc/$")({
  server: {
    handlers: {
      GET: async ({ request }) => await handler(request),
      POST: async ({ request }) => await handler(request),
    },
  },
});
