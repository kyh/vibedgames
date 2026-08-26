import { createFileRoute } from "@tanstack/react-router";

import { createRpcContext } from "@/auth/server";
import { handleRpcRequest } from "@/lib/orpc-handler";

const handler = async (req: Request): Promise<Response> =>
  handleRpcRequest(req, await createRpcContext(req.headers));

export const Route = createFileRoute("/api/orpc/$")({
  server: {
    handlers: {
      GET: ({ request }) => handler(request),
      POST: ({ request }) => handler(request),
    },
  },
});
